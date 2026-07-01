/**
 * MKassa (MBank) QR-платежи → МойКласс
 *
 * Использует ОТДЕЛЬНЫЙ МойКласс-ключ (MOYKLASS_PAYMENTS_API_KEY),
 * чтобы не конкурировать за токен с основным ключом портфолио (MOYKLASS_API_KEY
 * в server.js) — см. architecture-обсуждение и mkassa-integration-plan.md.
 *
 * ВАЖНО: в документации MKassa нет подписи/HMAC для коллбэка — коллбэку нельзя
 * доверять напрямую. Поэтому при получении коллбэка мы всегда перепроверяем
 * статус отдельным GET-запросом к MKassa своим же api-key, прежде чем
 * зачислять платёж в МойКласс.
 *
 * Переменные окружения (задать на Railway):
 *   MKASSA_CASHIER_API_KEY     — cashier api-key из личного кабинета MKassa
 *   MOYKLASS_PAYMENTS_API_KEY  — отдельный company-level ключ МойКласс, только для платежей
 *   MOYKLASS_PAYMENT_TYPE_ID   — (опционально) id типа оплаты в МойКласс; по умолчанию
 *                                 116679 («ОнлайнОплата»), см. константу ниже
 *   MOYKLASS_CASHBOX_ID        — (опционально) id кассы в МойКласс; по умолчанию
 *                                 3289 («Касса Онлайн оплата»)
 *   MKASSA_DEFAULT_FILIAL_ID   — (опционально) filialId по умолчанию, если не передан в запросе
 *
 * Сумма платежа берётся не вручную, а из активного абонемента ученика
 * (GET /v1/company/userSubscriptions) — там уже есть цена по уровню/курсу,
 * индивидуальная скидка (discount, %) и доп. компенсация (extraDiscount),
 * и МойКласс сам считает итоговую price и остаток долга remindSumm. Отдельный
 * "признак скидки" заводить не нужно — он уже в CRM, просто назначается
 * администратором на абонементе как обычно.
 *
 * ИЗВЕСТНОЕ ОГРАНИЧЕНИЕ MVP: /mkassa/create-payment сейчас не проверяет,
 * что запрос пришёл от авторизованного родителя (в кабинете ещё нет parent-auth).
 * До запуска в бой — обязательно повесить сюда проверку сессии родителя,
 * иначе кто угодно сможет запросить статус чужого абонемента и сгенерировать
 * на него QR (сумма при этом всегда берётся живьём из МойКласс, подменить её
 * в запросе нельзя — но платить за чужого ребёнка технически можно будет).
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const MKASSA_BASE = 'https://api.mkassa.kg/api/partners';
const MKASSA_KEY = process.env.MKASSA_CASHIER_API_KEY;
const MK_PAYMENTS_KEY = process.env.MOYKLASS_PAYMENTS_API_KEY;
// Значения по умолчанию — «ОнлайнОплата» (тип оплаты) и «Касса Онлайн оплата»,
// найдены через админ-панель 01.07.2026. Можно переопределить переменной
// окружения на Railway, без изменения кода, если понадобится сменить.
const MK_PAYMENT_TYPE_ID = process.env.MOYKLASS_PAYMENT_TYPE_ID || '116679';
const MK_CASHBOX_ID = process.env.MOYKLASS_CASHBOX_ID || '3289';
const DEFAULT_FILIAL_ID = process.env.MKASSA_DEFAULT_FILIAL_ID;

const MK_AUTH_URL = 'https://api.moyklass.com/v1/company/auth/getToken';
const MK_PAYMENTS_URL = 'https://api.moyklass.com/v1/company/payments';
const MK_USERSUBS_URL = 'https://api.moyklass.com/v1/company/userSubscriptions';

// ─── Отдельный токен МойКласс для платежей (Payments key) ──────────────────
let paymentsToken = null;
let paymentsTokenPromise = null;

async function getPaymentsToken() {
  if (paymentsToken && paymentsToken.expiresAt > Date.now() + 60_000) {
    return paymentsToken.accessToken;
  }
  if (paymentsTokenPromise) return paymentsTokenPromise;
  if (!MK_PAYMENTS_KEY) {
    throw new Error('MOYKLASS_PAYMENTS_API_KEY не задан в переменных окружения');
  }
  paymentsTokenPromise = axios.post(MK_AUTH_URL, { apiKey: MK_PAYMENTS_KEY }).then(r => {
    const { accessToken, expiresAt } = r.data;
    paymentsToken = {
      accessToken,
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : Date.now() + 6 * 24 * 60 * 60 * 1000,
    };
    paymentsTokenPromise = null;
    return accessToken;
  }).catch(err => {
    paymentsTokenPromise = null;
    throw err;
  });
  return paymentsTokenPromise;
}

// ─── Клиент MKassa ───────────────────────────────────────────────────────────
function mkassaHeaders() {
  if (!MKASSA_KEY) throw new Error('MKASSA_CASHIER_API_KEY не задан в переменных окружения');
  return { Authorization: `api-key ${MKASSA_KEY}`, 'Content-Type': 'application/json' };
}

async function createDynamicQr({ amountTyin, metadata }) {
  const { data } = await axios.post(
    `${MKASSA_BASE}/transactions/init_payment/`,
    { amount: amountTyin, is_long_living: true, metadata },
    { headers: mkassaHeaders() }
  );
  return data; // { id, status, payment_token, amount, ... }
}

async function getTransactionStatus(id) {
  const { data } = await axios.get(
    `${MKASSA_BASE}/transactions/${id}/`,
    { headers: mkassaHeaders() }
  );
  return data;
}

async function cancelTransaction(id) {
  const { data } = await axios.put(
    `${MKASSA_BASE}/transactions/${id}/cancel/`,
    {},
    { headers: mkassaHeaders() }
  );
  return data;
}

// ─── Абонементы ученика (Payments key) — чтобы не спрашивать сумму руками ───
// МойКласс уже хранит per-абонемент скидку (discount, % и extraDiscount,
// фикс. сумма) и сам считает итоговую price и остаток долга (remindSumm) —
// отдельного «признака скидки» заводить не нужно, он уже есть в CRM и
// назначается администратором в самом МойКласс как обычно.
async function getActiveUserSubscriptions(userId) {
  const token = await getPaymentsToken();
  // ВАЖНО: параметр называется именно statusId (не userSubscriptionStatus —
  // это была ошибка в первой версии, из-за неё МойКласс не фильтровал по
  // статусу как ожидалось). 2 = Активный.
  const { data } = await axios.get(MK_USERSUBS_URL, {
    headers: { 'x-access-token': token },
    params: { userId, statusId: 2 },
  });
  return data.subscriptions || [];
}

async function getUserSubscriptionById(userSubscriptionId) {
  const token = await getPaymentsToken();
  const { data } = await axios.get(`${MK_USERSUBS_URL}/${userSubscriptionId}`, {
    headers: { 'x-access-token': token },
  });
  return data;
}

function dueFromSubscription(s) {
  // remindSumm — уже посчитанный МойКласс остаток долга; если вдруг не пришёл,
  // считаем сами: price (с учётом скидки/доп. компенсации) минус оплачено
  if (s.remindSumm != null) return Number(s.remindSumm);
  return Math.max(0, Number(s.price || 0) - Number(s.payed || 0));
}

// ─── Создание платежа в МойКласс (Payments key) ─────────────────────────────
async function createMoyklassPayment({ userId, summa, userSubscriptionId, filialId, comment }) {
  const token = await getPaymentsToken();
  const body = {
    optype: 'income',
    userId,
    date: new Date().toISOString().split('T')[0],
    summa,
    comment,
  };
  const resolvedFilialId = filialId || DEFAULT_FILIAL_ID;
  if (resolvedFilialId) body.filialId = Number(resolvedFilialId);
  if (userSubscriptionId) body.userSubscriptionId = Number(userSubscriptionId);
  if (MK_PAYMENT_TYPE_ID) body.paymentTypeId = Number(MK_PAYMENT_TYPE_ID);
  if (MK_CASHBOX_ID) body.cashboxId = Number(MK_CASHBOX_ID);

  const { data } = await axios.post(MK_PAYMENTS_URL, body, {
    headers: { 'x-access-token': token, 'Content-Type': 'application/json' },
  });
  return data;
}

// ─── Персистентное хранилище транзакций (переживает передеплой — см. паттерн
// loadTeachers/saveTeachers в server.js, тот же DATA_DIR/Volume) ────────────
function makeStore(dataDir) {
  const dir = dataDir && fs.existsSync(dataDir) ? dataDir : '/tmp';
  const file = path.join(dir, 'mkassa_transactions.json');

  function load() {
    try {
      if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) { console.error('Не удалось прочитать mkassa_transactions.json:', e.message); }
    return {};
  }
  function save(map) {
    try { fs.writeFileSync(file, JSON.stringify(map, null, 2)); }
    catch (e) { console.error('Не удалось сохранить mkassa_transactions.json:', e.message); }
  }

  let tx = load();
  return {
    get: (id) => tx[id],
    set: (id, record) => { tx[id] = record; save(tx); },
    all: () => tx,
  };
}

// ─── Роуты ───────────────────────────────────────────────────────────────────
function registerMkassaRoutes(app, { DATA_DIR, courseLevels = {} } = {}) {
  const store = makeStore(DATA_DIR);

  // Активные абонементы ученика — фронтенд показывает их вместо того, чтобы
  // просить родителя вручную вводить сумму (стоимость зависит от уровня и
  // от индивидуальной скидки, которая уже назначается в самом МойКласс).
  app.get('/mkassa/subscriptions/:userId', async (req, res) => {
    try {
      const userId = Number(req.params.userId);
      const subs = await getActiveUserSubscriptions(userId);
      // Не фильтруем «нечего платить» здесь — иначе уже оплаченный абонемент
      // выглядит так же, как «абонемент вообще не найден», и это невозможно
      // отличить снаружи. Решение, что показывать, оставляем фронтенду.
      const data = subs.map(s => ({
        userSubscriptionId: s.id,
        courseId: (s.courseIds || [])[0] || null,
        level: courseLevels[(s.courseIds || [])[0]] || null,
        originalPrice: s.originalPrice,
        discountPct: s.discount || 0,
        extraDiscount: s.extraDiscount || 0,
        price: s.price,
        payed: s.payed,
        due: dueFromSubscription(s),
        period: s.period,
        beginDate: s.beginDate,
        endDate: s.endDate,
        statusId: s.statusId,
      }));
      res.json({ ok: true, data, _debug: { userId, statusFilter: 2, totalFound: subs.length } });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
    }
  });

  // Родитель нажал «Оплатить» в кабинете — создаём динамический QR.
  // Если передан userSubscriptionId — сумму берём ЖИВЬЁМ из МойКласс
  // (remindSumm/price с учётом скидки), а не из того, что прислал фронтенд —
  // чтобы никто не мог подменить сумму в запросе.
  app.post('/mkassa/create-payment', async (req, res) => {
    try {
      const { userId, amountSom, userSubscriptionId, filialId, comment } = req.body || {};
      if (!userId) {
        return res.status(400).json({ ok: false, error: 'Нужен userId' });
      }

      let finalAmountSom;
      if (userSubscriptionId) {
        const sub = await getUserSubscriptionById(userSubscriptionId);
        if (!sub || Number(sub.userId) !== Number(userId)) {
          return res.status(400).json({ ok: false, error: 'Абонемент не найден для этого ученика' });
        }
        finalAmountSom = dueFromSubscription(sub);
        if (!(finalAmountSom > 0)) {
          return res.status(400).json({ ok: false, error: 'По этому абонементу нет долга к оплате' });
        }
      } else if (amountSom) {
        // Ручной ввод суммы — оставлен как запасной вариант (например,
        // если у ученика ещё нет абонемента в МойКласс)
        finalAmountSom = Number(amountSom);
      } else {
        return res.status(400).json({ ok: false, error: 'Нужны userSubscriptionId или amountSom' });
      }

      const amountTyin = Math.round(finalAmountSom * 100);

      const metadata = {
        key1: String(userId),
        key2: userSubscriptionId ? String(userSubscriptionId) : '',
        key3: filialId ? String(filialId) : '',
        key4: '',
        key5: comment ? String(comment).slice(0, 150) : '',
      };

      const mkassaTx = await createDynamicQr({ amountTyin, metadata });

      store.set(mkassaTx.id, {
        id: mkassaTx.id,
        userId: Number(userId),
        userSubscriptionId: userSubscriptionId ? Number(userSubscriptionId) : null,
        filialId: filialId ? Number(filialId) : null,
        amountSom: finalAmountSom,
        amountTyin,
        comment: comment || null,
        status: 'pending',
        createdAt: new Date().toISOString(),
        paidAt: null,
        moyklassPaymentId: null,
      });

      res.json({
        ok: true,
        data: {
          id: mkassaTx.id,
          paymentToken: mkassaTx.payment_token,
          amountSom: finalAmountSom,
          status: mkassaTx.status,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
    }
  });

  // Фронтенд опрашивает статус, пока показывает QR
  app.get('/mkassa/status/:id', async (req, res) => {
    const record = store.get(req.params.id);
    if (!record) return res.status(404).json({ ok: false, error: 'Транзакция не найдена' });
    res.json({ ok: true, data: { status: record.status, paidAt: record.paidAt } });
  });

  // Отмена QR до оплаты (например, родитель закрыл модалку)
  app.post('/mkassa/cancel/:id', async (req, res) => {
    try {
      const record = store.get(req.params.id);
      if (!record) return res.status(404).json({ ok: false, error: 'Транзакция не найдена' });
      if (record.status === 'pending') {
        await cancelTransaction(req.params.id).catch(() => {});
        store.set(req.params.id, { ...record, status: 'canceled' });
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Коллбэк от MKassa. НЕ доверяем телу запроса — только используем как триггер
  // и перепроверяем статус отдельным GET-запросом своим же api-key.
  app.post('/mkassa/callback', async (req, res) => {
    // Всегда отвечаем 200 — иначе MKassa будет бесконечно ретраить из-за наших внутренних ошибок
    res.status(200).json({ ok: true });

    try {
      const id = req.body?.id;
      if (!id) return;

      const record = store.get(id);
      if (!record) {
        console.warn(`MKassa callback: неизвестная транзакция ${id}`);
        return;
      }
      if (record.status === 'paid') return; // идемпотентность

      const fresh = await getTransactionStatus(id);
      if (fresh.status !== 'paid') {
        store.set(id, { ...record, status: fresh.status });
        return;
      }
      if (Number(fresh.amount) !== Number(record.amountTyin)) {
        console.error(`MKassa: несовпадение суммы для ${id}: ожидали ${record.amountTyin}, получили ${fresh.amount}`);
        store.set(id, { ...record, status: 'amount_mismatch' });
        return;
      }

      const payment = await createMoyklassPayment({
        userId: record.userId,
        summa: record.amountSom,
        userSubscriptionId: record.userSubscriptionId,
        filialId: record.filialId,
        comment: `MKassa QR, tx ${id}${record.comment ? ' — ' + record.comment : ''}`,
      });

      store.set(id, {
        ...record,
        status: 'paid',
        paidAt: fresh.paid_at || new Date().toISOString(),
        moyklassPaymentId: payment.id,
      });
      console.log(`MKassa: платёж ${id} зачислен в МойКласс, paymentId=${payment.id}`);
    } catch (e) {
      console.error('MKassa callback error:', e.message, e.response?.data || '');
    }
  });

  // Ручная сверка на случай, если коллбэк не пришёл (можно дёргать по крону раз в минуту)
  app.post('/mkassa/recheck/:id', async (req, res) => {
    try {
      const record = store.get(req.params.id);
      if (!record) return res.status(404).json({ ok: false, error: 'Транзакция не найдена' });
      if (record.status === 'paid') return res.json({ ok: true, data: record });

      const fresh = await getTransactionStatus(req.params.id);
      if (fresh.status === 'paid' && Number(fresh.amount) === Number(record.amountTyin)) {
        const payment = await createMoyklassPayment({
          userId: record.userId,
          summa: record.amountSom,
          userSubscriptionId: record.userSubscriptionId,
          filialId: record.filialId,
          comment: `MKassa QR, tx ${req.params.id}${record.comment ? ' — ' + record.comment : ''}`,
        });
        store.set(req.params.id, {
          ...record, status: 'paid', paidAt: fresh.paid_at || new Date().toISOString(), moyklassPaymentId: payment.id,
        });
      } else {
        store.set(req.params.id, { ...record, status: fresh.status });
      }
      res.json({ ok: true, data: store.get(req.params.id) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
    }
  });
}

module.exports = registerMkassaRoutes;

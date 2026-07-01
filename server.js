/**
 * BE School — Portfolio Backend
 * Node.js + Express
 * Connects to МойКласс API and serves portfolio data
 */

const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');
const registerMkassaRoutes = require('./mkassa');

const app = express();
app.use(cors());
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const MK_BASE   = 'https://api.moyklass.com/v1/company';
const MK_KEY    = process.env.MOYKLASS_API_KEY; // хранить в .env, не в коде
const PORT      = process.env.PORT || 3001;

// ─── KEYWORD DICTIONARY (редактируется в админ-панели) ─────────────────────
let SKILL_DICT = {
  Grammar:    ['grammar','грамматика','tense','past','present','future',
               'passive','conditional','артикль','clause','preposition',
               'prepositions','tag','questions'],
  Reading:    ['reading','чтение','text','текст','article','статья',
               'comprehension','passage','отрывок'],
  Speaking:   ['speaking','говорение','discussion','дискуссия','dialogue',
               'диалог','presentation','club','debate'],
  Vocabulary: ['vocabulary','vocab','слова','words','lexis','лексика',
               'new words','unit words'],
  Writing:    ['writing','письмо','essay','эссе','letter','composition',
               'report','сочинение'],
  Listening:  ['listening','аудирование','audio','podcast','video',
               'dictation'],
};

// Маппинг courseId → уровень (из реальных данных BE School)
const COURSE_LEVELS = {
  92307:  'Beginner',
  92312:  'ABC',
  92313:  'Elementary',
  92323:  'Intermediate',
  92324:  'Pre-Int',
  92442:  'IELTS',
  95123:  'Express',
  128121: 'Upper-Int',
  101674: 'Speaking',
};

const LEVEL_ORDER = ['ABC','Beginner','Elementary','Pre-Int',
                     'Intermediate','Upper-Int','IELTS','Speaking'];

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// МойКласс использует двухэтапную авторизацию:
// 1) POST /v1/company/auth/getToken { apiKey } → { accessToken, expiresAt }
// 2) Все остальные запросы — Authorization: Bearer <accessToken>
let mkToken = null;       // { accessToken, expiresAt }
let mkTokenPromise = null; // защита от параллельных запросов токена

async function getMkToken() {
  // Токен ещё действителен — переиспользуем (с запасом 60 сек)
  if (mkToken && mkToken.expiresAt > Date.now() + 60_000) {
    return mkToken.accessToken;
  }
  // Уже идёт получение токена — ждём тот же промис, не дублируем запрос
  if (mkTokenPromise) return mkTokenPromise;

  mkTokenPromise = axios.post('https://api.moyklass.com/v1/company/auth/getToken', {
    apiKey: MK_KEY,
  }).then(r => {
    const { accessToken, expiresAt } = r.data;
    mkToken = {
      accessToken,
      // expiresAt от МойКласс — ISO-строка либо unix; на всякий случай считаем +50 мин
      expiresAt: expiresAt ? new Date(expiresAt).getTime() : Date.now() + 50 * 60_000,
    };
    mkTokenPromise = null;
    return accessToken;
  }).catch(err => {
    mkTokenPromise = null;
    throw err;
  });

  return mkTokenPromise;
}

const mk = async (path, params = {}) => {
  const token = await getMkToken();
  return axios.get(`${MK_BASE}${path}`, {
    headers: { 'x-access-token': token },
    params,
  }).then(r => r.data);
};

function detectSkill(topic) {
  if (!topic) return null;
  const t = topic.toLowerCase();
  for (const [skill, keywords] of Object.entries(SKILL_DICT)) {
    if (keywords.some(kw => t.includes(kw))) return skill;
  }
  return null;
}

function levelProgress(levelName, avgScore) {
  // % прогресса внутри уровня на основе среднего балла
  if (!avgScore) return 0;
  return Math.min(100, Math.round(avgScore));
}

// In-memory cache (в продакшене — Redis)
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 час

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data; });
}

// ─── CORE: собрать портфолио одного ученика ──────────────────────────────────
async function buildPortfolio(userId) {
  return cached(`portfolio:${userId}`, async () => {

    // 1. Записи ученика в группах
    const joinsRes = await mk('/joins', { userId: userId, limit: 50 });
    const joins    = joinsRes.joins || [];

    // Найти активную группу (по дате последнего реального посещения)
    const withVisits = joins.filter(j => j.stats?.lastVisit);
    const activeJoin = withVisits.length
      ? withVisits.sort((a, b) => new Date(b.stats.lastVisit) - new Date(a.stats.lastVisit))[0]
      : (joins.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0] || joins[0]);

    const courseId  = activeJoin?.courseId;
    const classId   = activeJoin?.classId;
    const level     = COURSE_LEVELS[courseId] || 'Elementary';
    const totalPaid = joins.reduce((s, j) => s + (j.stats?.totalPayed || 0), 0);

    // 2. Оценки и посещаемость — только по активной группе
    const recordsRes = await mk('/lessonRecords', { userId: userId, classId: classId, limit: 200 });
    const records    = recordsRes.lessonRecords || [];

    const visited = records.filter(r => r.visit);
    const attend  = records.length
      ? Math.round((visited.length / records.length) * 100) : 0;

    // Оценки (lessonMark — академическая оценка, если учитель ввёл)
    const withMark = records.filter(r => r.lessonMark != null && r.lessonMark > 0);
    const avgMark  = withMark.length
      ? Math.round(withMark.reduce((s, r) => s + r.lessonMark, 0) / withMark.length)
      : null;

    // 3. Уроки с темами для skill-баров
    const lessonsRes = await mk('/lessons', {
      classId: classId,
      limit: 100,
      dateFrom: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0],
    });
    const lessons = lessonsRes.lessons || [];

    // Сопоставить records с lessons
    const lessonMap = new Map(lessons.map(l => [l.id, l]));
    const skillScores = {};

    for (const rec of records) {
      if (!rec.visit || !rec.lessonMark) continue;
      const lesson = lessonMap.get(rec.lessonId);
      if (!lesson) continue;
      const skill = detectSkill(lesson.topic);
      if (!skill) continue;
      if (!skillScores[skill]) skillScores[skill] = [];
      skillScores[skill].push(rec.lessonMark);
    }

    const skills = {};
    for (const [skill, scores] of Object.entries(skillScores)) {
      if (scores.length >= 3) { // минимум 3 оценки
        skills[skill] = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
      }
    }

    // 4. Последние уроки для истории
    const recentLessons = records
      .filter(r => r.visit)
      .sort((a, b) => b.id - a.id)
      .slice(0, 8)
      .map(r => {
        const lesson = lessonMap.get(r.lessonId);
        return {
          date:   lesson?.date || '—',
          topic:  lesson?.topic || 'Урок',
          skill:  detectSkill(lesson?.topic),
          mark:   r.lessonMark || null,
          hw:     r.homeMark   || null,
        };
      });

    // 5. ДЗ
    const hwRecords = records.filter(r => r.homeMark != null && r.homeMark > 0);
    const hwAvg     = hwRecords.length
      ? Math.round(hwRecords.reduce((s, r) => s + r.homeMark, 0) / hwRecords.length)
      : null;

    return {
      userId,
      level,
      levelProgress: levelProgress(level, avgMark),
      levelIndex:    LEVEL_ORDER.indexOf(level),
      attendance:    attend,
      totalLessons:  records.length,
      visitedLessons:visited.length,
      avgMark,
      hwAvg,
      skills,            // { Grammar: 85, Reading: 90, ... } — только если ≥3 оценок
      recentLessons,
      classId,
      courseId,
      lastSync:      new Date().toISOString(),
      // Флаги для UI
      hasMarks:      withMark.length > 0,
      hasSkills:     Object.keys(skills).length > 0,
      hasTopics:     lessons.some(l => l.topic),
    };
  });
}

// ─── ПЕРСИСТЕНТНОЕ ХРАНИЛИЩЕ ──────────────────────────────────────────────
// Учителя и сессии сохраняются в JSON-файл на диске, чтобы НЕ стираться
// при каждом передеплое. Railway: подключи Volume с mount path = DATA_DIR
// (по умолчанию /data). Если volume не подключён — данные хранятся в /tmp
// (тоже переживают рестарт процесса, но НЕ переживают пересоздание контейнера
// при некоторых типах деплоя — поэтому Volume настоятельно рекомендуется).
const DATA_DIR  = process.env.DATA_DIR || '/data';
const DATA_FILE = path.join(fs.existsSync(DATA_DIR) ? DATA_DIR : '/tmp', 'teachers.json');

function loadTeachers() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.error('Не удалось прочитать teachers.json:', e.message); }
  return [];
}

function saveTeachers(teachers) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(teachers, null, 2));
  } catch (e) { console.error('Не удалось сохранить teachers.json:', e.message); }
}

// Админ добавляет учителей здесь: email из МойКласс + managerId + свой PIN.
// PIN — простой пароль который задаёт администратор, не связан с МойКласс паролем.
let TEACHERS = loadTeachers();

function findTeacher(email, pin) {
  const norm = (s) => (s || '').trim().toLowerCase();
  return TEACHERS.find(t =>
    norm(t.email) === norm(email) && t.pin === String(pin).trim()
  );
}

// Простые токены сессии (in-memory — это ОК, при разлогине просто войти заново)
const sessions = new Map(); // sessionToken → { email, managerId, name, createdAt }

function createSession(teacher) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { ...teacher, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  const s = sessions.get(token);
  if (!s) return null;
  // Сессия живёт 30 дней
  if (Date.now() - s.createdAt > 30 * 24 * 60 * 60 * 1000) {
    sessions.delete(token);
    return null;
  }
  return s;
}

// Middleware: проверка авторизации учителя
function requireAuth(req, res, next) {
  const token = req.headers['x-session-token'];
  const session = token ? getSession(token) : null;
  if (!session) {
    return res.status(401).json({ ok: false, error: 'Не авторизован' });
  }
  req.teacher = session;
  next();
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Вход учителя: email + PIN → токен сессии
app.post('/auth/login', (req, res) => {
  const { email, pin } = req.body || {};
  if (!email || !pin) {
    return res.status(400).json({ ok: false, error: 'Укажите email и PIN' });
  }
  const teacher = findTeacher(email, pin);
  if (!teacher) {
    return res.status(401).json({ ok: false, error: 'Неверный email или PIN' });
  }
  const token = createSession(teacher);
  res.json({
    ok: true,
    token,
    teacher: { email: teacher.email, name: teacher.name, managerId: teacher.managerId },
  });
});

// Проверка текущей сессии (для автологина при открытии страницы)
app.get('/auth/me', requireAuth, (req, res) => {
  res.json({ ok: true, teacher: req.teacher });
});

// Выход
app.post('/auth/logout', requireAuth, (req, res) => {
  const token = req.headers['x-session-token'];
  sessions.delete(token);
  res.json({ ok: true });
});

// Группы конкретного учителя (только те где он назначен ведущим)
app.get('/teacher/classes', requireAuth, async (req, res) => {
  try {
    const managerId = req.teacher.managerId;

    // GET /classes возвращает ГОЛЫЙ массив в корне ответа (не {classes:[...]})
    const allRes = await mk('/classes', { limit: 500 });
    const allClasses = Array.isArray(allRes) ? allRes : (allRes.classes || []);

    // Группа ведётся этим учителем, если его managerId есть в поле managerIds
    const myClasses = allClasses.filter(c =>
      Array.isArray(c.managerIds) && c.managerIds.includes(managerId)
    );

    // Берём только реально активные группы (не архивные)
    const activeClasses = myClasses.filter(c => c.status === 'opened');
    const finalClasses = activeClasses.length > 0 ? activeClasses : myClasses;

    const classes = finalClasses.map(c => ({
      classId:  c.id,
      name:     c.name,
      courseId: c.courseId,
      level:    COURSE_LEVELS[c.courseId] || c.name,
      filialId: c.filialId,
      status:   c.status,
    }));

    res.json({
      ok: true,
      data: classes,
      _debug: {
        managerId,
        totalClassesChecked: allClasses.length,
        myClassesCount: myClasses.length,
        activeClassesCount: activeClasses.length,
      },
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      detail: e.response?.data || null,
    });
  }
});

// ─── ADMIN: пароль-защита (только ты) ───────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const adminSessions = new Set(); // простые токены админ-сессии (in-memory)

app.post('/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD не настроен на сервере' });
  }
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  adminSessions.add(token);
  res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ ok: false, error: 'Нужен доступ администратора' });
  }
  next();
}

// ─── ADMIN: управление учителями ────────────────────────────────────────────

// Список сотрудников из МойКласс (чтобы админ выбрал manager_id, не вводя вслепую)
app.get('/admin/managers', requireAdmin, async (req, res) => {
  try {
    const raw = await mk('/managers', { limit: 100 });
    const managers = (raw.managers || raw.data || (Array.isArray(raw) ? raw : []) || []).map(m => ({
      managerId: m.id,
      name: `${m.lastName || ''} ${m.firstName || ''}`.trim() || m.name || `#${m.id}`,
      email: m.email || null,
      phone: m.phone || null,
    }));
    res.json({ ok: true, data: managers, _raw: managers.length === 0 ? raw : undefined });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
  }
});

// Список всех учителей (без PIN в ответе)
app.get('/admin/teachers', requireAdmin, (req, res) => {
  res.json({
    ok: true,
    data: TEACHERS.map(t => ({ email: t.email, name: t.name, managerId: t.managerId })),
  });
});

// Добавить / обновить учителя
app.post('/admin/teachers', requireAdmin, (req, res) => {
  const { email, name, managerId, pin } = req.body || {};
  if (!email || !managerId || !pin) {
    return res.status(400).json({ ok: false, error: 'Нужны email, managerId, pin' });
  }
  const idx = TEACHERS.findIndex(t => t.email.toLowerCase() === email.toLowerCase());
  const record = { email, name: name || email, managerId: Number(managerId), pin: String(pin) };
  if (idx >= 0) TEACHERS[idx] = record;
  else TEACHERS.push(record);
  saveTeachers(TEACHERS);
  res.json({ ok: true, data: { email, name: record.name, managerId: record.managerId } });
});

// Удалить учителя
app.delete('/admin/teachers/:email', requireAdmin, (req, res) => {
  TEACHERS = TEACHERS.filter(t => t.email.toLowerCase() !== req.params.email.toLowerCase());
  saveTeachers(TEACHERS);
  res.json({ ok: true });
});

// Портфолио по ID ученика (для родителей — без авторизации, по UUID-ссылке)
app.get('/p/:token', async (req, res) => {
  try {
    // В продакшене token → userId через таблицу tokens в БД
    // Здесь упрощённо: token = userId (заменить на UUID в продакшене)
    const userId   = parseInt(req.params.token);
    const portfolio = await buildPortfolio(userId);
    res.json({ ok: true, data: portfolio });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: e.message,
      detail: e.response?.data || null,
      url: e.config?.url || null,
    });
  }
});

// Список учеников группы (для учителя)
app.get('/class/:classId/students', async (req, res) => {
  try {
    const classId = req.params.classId;

    // 1. Записи учеников в группе (МойКласс возвращает голый массив в корне)
    const joinsRes = await mk('/joins', { classId, limit: 100 });
    const joins = Array.isArray(joinsRes) ? joinsRes : (joinsRes.joins || []);

    // 2. Все отметки посещаемости по этой группе — считаем реальный % сами,
    // а не доверяем agregированной статистике МойКласс (она может быть неточной)
    const recordsRes = await mk('/lessonRecords', { classId, limit: 500 });
    const records = Array.isArray(recordsRes) ? recordsRes : (recordsRes.lessonRecords || []);

    // Группируем по ученику: всего записей / посещено / оценки
    const attendanceByUser = {};
    for (const r of records) {
      const uid = r.userId;
      if (!attendanceByUser[uid]) attendanceByUser[uid] = { total: 0, visited: 0, marks: [] };
      attendanceByUser[uid].total += 1;
      if (r.visit) attendanceByUser[uid].visited += 1;
      if (r.lessonMark != null && r.lessonMark > 0) attendanceByUser[uid].marks.push(r.lessonMark);
    }

    // 3. Имена учеников — МойКласс не отдаёт ФИО в /joins, нужен отдельный запрос
    const names = await Promise.all(
      joins.map(j =>
        mk(`/users/${j.userId}`)
          .then(u => {
            const user = Array.isArray(u) ? u[0] : u;
            const full = `${user?.name || ''} ${user?.surname || ''}`.trim();
            return full || `Ученик #${j.userId}`;
          })
          .catch(() => `Ученик #${j.userId}`)
      )
    );

    const students = joins.map((j, i) => {
      const att = attendanceByUser[j.userId] || { total: 0, visited: 0, marks: [] };
      const avgMark = att.marks.length
        ? Math.round(att.marks.reduce((a, b) => a + b, 0) / att.marks.length)
        : null;
      return {
        userId:       j.userId,
        name:         names[i],
        visits:       att.visited,
        totalLessons: att.total,
        attendance:   att.total > 0 ? Math.round((att.visited / att.total) * 100) : null,
        avgMark,
        lastVisit:    j.stats?.lastVisit || null,
        portfolioUrl: `/p/${j.userId}`,
      };
    });

    res.json({ ok: true, data: students });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
  }
});

// Справочники МойКласс для настройки MKassa (одноразовый lookup для админа —
// чтобы найти id типа оплаты "Безнал" и, при желании, id кассы под MKassa,
// и прописать их в переменные окружения MOYKLASS_PAYMENT_TYPE_ID /
// MOYKLASS_CASHBOX_ID на Railway, без использования MCP-коннектора).
app.get('/admin/moyklass/payment-types', requireAdmin, async (req, res) => {
  try {
    const raw = await mk('/paymentTypes');
    res.json({ ok: true, data: raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
  }
});

app.get('/admin/moyklass/cashboxes', requireAdmin, async (req, res) => {
  try {
    const raw = await mk('/cashboxes');
    res.json({ ok: true, data: raw });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, detail: e.response?.data || null });
  }
});

// Редактор словаря навыков (для админа)
app.get('/admin/skills-dict', requireAdmin, (req, res) => {
  res.json({ ok: true, data: SKILL_DICT });
});

app.put('/admin/skills-dict', requireAdmin, (req, res) => {
  SKILL_DICT = req.body;
  cache.clear(); // Сбросить кэш при изменении словаря
  res.json({ ok: true });
});

// Принудительная синхронизация
app.post('/admin/sync/:userId', requireAdmin, async (req, res) => {
  cache.delete(`portfolio:${req.params.userId}`);
  try {
    const portfolio = await buildPortfolio(parseInt(req.params.userId));
    res.json({ ok: true, data: portfolio });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Healthcheck — также проверяет что МойКласс ключ валиден
app.get('/health', async (req, res) => {
  const base = { ok: true, version: '1.0', timestamp: new Date(), mkassaEnabled: process.env.MKASSA_ENABLED !== 'false' };
  try {
    await getMkToken();
    res.json({ ...base, moyklass: 'connected' });
  } catch (e) {
    res.json({
      ...base,
      moyklass: 'error',
      moyklassError: e.response?.data || e.message,
    });
  }
});

// MKassa QR-платежи — отдельный, самодостаточный модуль (mkassa.js), подключаемый
// одной строкой. Отключается без изменения кода: MKASSA_ENABLED=false в Railway.
// Ничего в остальном backend'е не завязано на этот модуль — можно снести
// require и вызов ниже, и всё остальное продолжит работать как раньше.
const MKASSA_ENABLED = process.env.MKASSA_ENABLED !== 'false';

if (MKASSA_ENABLED) {
  registerMkassaRoutes(app, { DATA_DIR, courseLevels: COURSE_LEVELS });
  console.log('MKassa: модуль оплаты включён');
} else {
  console.log('MKassa: модуль оплаты отключён (MKASSA_ENABLED=false)');
  app.all('/mkassa/*', (req, res) => {
    res.status(503).json({ ok: false, error: 'Оплата временно недоступна' });
  });
}

app.listen(PORT, () =>
  console.log(`BE School Portfolio Backend running on :${PORT}`));

module.exports = app;

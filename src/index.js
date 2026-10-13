import configuration from '../config/bookings.json';

const BASE = 'https://libapp.ctu.edu.vn/dkptl';
const LOGIN_OK = 'Xin chào :)';
const BOOKING_OK = 'Đăng ký thành công :)';
const FORM_HEADERS = {
  Accept: '*/*',
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'X-Requested-With': 'XMLHttpRequest',
  Origin: 'https://libapp.ctu.edu.vn',
  Referer: `${BASE}/`,
};

class CookieJar {
  constructor() { this.values = new Map(); }
  update(response) {
    const values = response.headers.getSetCookie?.() ?? [];
    for (const setCookie of values) {
      const first = setCookie.split(';', 1)[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1);
      if (value) this.values.set(name, value);
      else this.values.delete(name);
    }
  }
  header() {
    return [...this.values].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function send(path, jar, body) {
  const headers = new Headers(body ? FORM_HEADERS : { Accept: 'text/html' });
  if (jar.header()) headers.set('Cookie', jar.header());
  const response = await fetch(`${BASE}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers,
    ...(body ? { body: new URLSearchParams(body).toString() } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
  });
  jar.update(response);
  return response;
}

function notice(html, text) {
  const divs = html.match(/<div\b[^>]*class\s*=\s*(['"])[^'"]*\btb_ok\b[^'"]*\1[^>]*>[\s\S]*?<\/div>/gi) ?? [];
  return divs.some(div => div.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() === text);
}

function getStudents(env) {
  if (!env.STUDENTS_JSON) throw new Error('Missing STUDENTS_JSON secret');
  const students = JSON.parse(env.STUDENTS_JSON);
  if (!students || typeof students !== 'object' || Array.isArray(students)) {
    throw new Error('STUDENTS_JSON must be an object');
  }
  return students;
}

function plan() {
  const tasks = [];
  for (const job of configuration.jobs) {
    if (!job.enabled) continue;
    for (const studentId of job.studentIds) {
      for (const room of job.rooms) {
        tasks.push({ job: job.name, studentId, room });
      }
    }
  }
  if (tasks.length > configuration.maxRequestsPerRun) {
    throw new Error(`Plan has ${tasks.length} bookings; limit is ${configuration.maxRequestsPerRun}`);
  }
  const keys = tasks.map(task => bookingKey(task));
  if (new Set(keys).size !== keys.length) {
    throw new Error('Duplicate student/room/date bookings in config');
  }
  for (const task of tasks) {
    if (!/^\d{2}-\d{2}-\d{4}$/.test(task.room.ngay_hoc)) {
      throw new Error(`Invalid date in job ${task.job}`);
    }
    for (const key of ['gc', 'id_c', 'id_p', 'ngay_hoc', 'sv_n']) {
      if (typeof task.room[key] !== 'string' || !task.room[key].length) {
        throw new Error(`Missing room field ${key} in job ${task.job}`);
      }
    }
  }
  return tasks;
}

function bookingKey(task) {
  const { studentId, room } = task;
  return `done:${encodeURIComponent(studentId)}:${encodeURIComponent(room.id_c)}:${encodeURIComponent(room.id_p)}:${encodeURIComponent(room.ngay_hoc)}`;
}

async function book(student, room) {
  const jar = new CookieJar();
  const init = await send('', jar);
  if (!init.ok) return { success: false, stage: 'session', status: init.status };
  const login = await send('dangnhap.php', jar, {
    txtusername: student.username,
    txtpassword: student.password,
  });
  const loginText = await login.text();
  if (!login.ok || !notice(loginText, LOGIN_OK)) {
    return { success: false, stage: 'login', status: login.status };
  }
  const response = await send('dangky.php', jar, room);
  const html = await response.text();
  return {
    success: response.ok && notice(html, BOOKING_OK),
    stage: 'booking',
    status: response.status,
    message: response.ok && notice(html, BOOKING_OK)
      ? 'Đăng ký thành công :)'
      : 'Không xác nhận được thành công; xem log server hoặc kiểm tra thủ công',
  };
}

async function run(env) {
  if (!configuration.enabled) return { disabled: true, message: 'Set enabled=true in config/bookings.json' };
  const tasks = plan();
  if (configuration.dryRun) return { dryRun: true, total: tasks.length, tasks };
  if (!env.BOOKINGS) throw new Error('Missing BOOKINGS KV binding');
  const students = getStudents(env);
  const results = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const key = bookingKey(task);
    if (await env.BOOKINGS.get(key)) {
      results.push({ ...task, success: true, skipped: 'already-booked' });
      continue;
    }
    const student = students[task.studentId];
    if (!student?.username || !student?.password) {
      results.push({ ...task, success: false, stage: 'configuration', message: 'Missing student credentials' });
      continue;
    }
    try {
      const result = await book(student, task.room);
      results.push({ ...task, ...result });
      if (result.success) {
        await env.BOOKINGS.put(key, JSON.stringify({ at: new Date().toISOString(), job: task.job }));
      }
    } catch (error) {
      results.push({ ...task, success: false, stage: 'network', message: error?.name || 'network-error' });
    }
    if (i < tasks.length - 1 && configuration.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, configuration.delayMs));
    }
  }
  return { total: tasks.length, success: results.filter(r => r.success && !r.skipped).length, results };
}

function authorized(request, env) {
  if (!env.API_KEY) return false;
  return request.headers.get('Authorization') === `Bearer ${env.API_KEY}`;
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/') return new Response('CTU Room Worker');
    if (!authorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (pathname === '/plan' && request.method === 'GET') {
      try { return Response.json({ enabled: configuration.enabled, dryRun: configuration.dryRun, tasks: plan() }); }
      catch (e) { return Response.json({ error: e.message }, { status: 400 }); }
    }
    if (pathname === '/run' && request.method === 'POST') {
      try { return Response.json(await run(env)); }
      catch (e) { return Response.json({ error: e.message }, { status: 500 }); }
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env).then(result => {
      console.log(JSON.stringify(result));
    }).catch(error => {
      console.error('Scheduled run failed:', error.message);
    }));
  },
};

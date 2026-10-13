
import configuration from "../config/bookings.json";

const BASE = "https://libapp.ctu.edu.vn/dkptl";

const LOGIN_OK = "Xin chào :)";
const BOOKING_OK = "Đăng ký thành công :)";

const FORM_HEADERS = {
  Accept: "*/*",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Origin: "https://libapp.ctu.edu.vn",
  Referer: `${BASE}/`,
};

// ==============================
// COOKIE SESSION
// ==============================

class CookieJar {
  constructor() {
    this.values = new Map();
  }

  update(response) {
    const values = response.headers.getSetCookie?.() ?? [];

    for (const setCookie of values) {
      const first = setCookie.split(";", 1)[0];
      const i = first.indexOf("=");

      if (i <= 0) continue;

      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1);

      if (value) {
        this.values.set(name, value);
      } else {
        this.values.delete(name);
      }
    }
  }

  header() {
    return [...this.values]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
}

// ==============================
// HTTP REQUEST
// ==============================

async function send(path, jar, body) {
  const headers = new Headers(
    body ? FORM_HEADERS : { Accept: "text/html" }
  );

  if (jar.header()) {
    headers.set("Cookie", jar.header());
  }

  const response = await fetch(`${BASE}/${path}`, {
    method: body ? "POST" : "GET",
    headers,
    ...(body
      ? { body: new URLSearchParams(body).toString() }
      : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });

  jar.update(response);

  return response;
}

// ==============================
// CHECK SERVER RESPONSE
// ==============================

function notice(html, text) {
  const divs =
    html.match(
      /<div\b[^>]*class\s*=\s*(['"])[^'"]*\btb_ok\b[^'"]*\1[^>]*>[\s\S]*?<\/div>/gi
    ) ?? [];

  return divs.some(
    div =>
      div
        .replace(/<[^>]*>/g, "")
        .replace(/\s+/g, " ")
        .trim() === text
  );
}

// ==============================
// STUDENTS
// ==============================

function getStudents(env) {
  if (!env.STUDENTS_JSON) {
    throw new Error("Missing STUDENTS_JSON secret");
  }

  const students = JSON.parse(env.STUDENTS_JSON);

  if (
    !students ||
    typeof students !== "object" ||
    Array.isArray(students)
  ) {
    throw new Error("STUDENTS_JSON must be an object");
  }

  return students;
}

// ==============================
// BOOKING PLAN
// ==============================

function bookingKey(task) {
  const { studentId, room } = task;

  return [
    "done",
    encodeURIComponent(studentId),
    encodeURIComponent(room.id_c),
    encodeURIComponent(room.id_p),
    encodeURIComponent(room.ngay_hoc),
  ].join(":");
}

function plan() {
  const tasks = [];

  for (const job of configuration.jobs) {
    if (!job.enabled) continue;

    for (const studentId of job.studentIds) {
      for (const room of job.rooms) {
        tasks.push({
          job: job.name,
          studentId,
          room,
        });
      }
    }
  }

  if (tasks.length > configuration.maxRequestsPerRun) {
    throw new Error(
      `Plan has ${tasks.length} bookings; limit is ${configuration.maxRequestsPerRun}`
    );
  }

  const keys = tasks.map(task => bookingKey(task));

  if (new Set(keys).size !== keys.length) {
    throw new Error(
      "Duplicate student/room/date bookings in config"
    );
  }

  for (const task of tasks) {
    const room = task.room;

    if (!/^\d{2}-\d{2}-\d{4}$/.test(room.ngay_hoc)) {
      throw new Error(`Invalid date in job ${task.job}`);
    }

    for (const key of [
      "gc",
      "id_c",
      "id_p",
      "ngay_hoc",
      "sv_n",
    ]) {
      if (
        typeof room[key] !== "string" ||
        !room[key].length
      ) {
        throw new Error(
          `Missing room field ${key} in job ${task.job}`
        );
      }
    }
  }

  return tasks;
}

// ==============================
// TELEGRAM NOTIFICATION
// ==============================

async function sendTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.warn("Telegram secrets are not configured");
    return false;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
      }),
      signal: AbortSignal.timeout(10000),
    }
  );

  if (!response.ok) {
    throw new Error(`Telegram HTTP ${response.status}`);
  }

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      data.description || "Telegram API error"
    );
  }

  return true;
}

async function notifyBookingSuccess(env, task, student) {
  const { room } = task;

  const timestamp = new Date().toLocaleString("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour12: false,
  });

  const message = [
    "✅ ĐĂNG KÝ PHÒNG THÀNH CÔNG",
    "",
    `📋 Job: ${task.job}`,
    `📅 Ngày: ${room.ngay_hoc}`,
    `🕒 Ca: ${room.id_c}`,
    `🏫 Phòng: ${room.id_p}`,
    `👥 Số lượng: ${room.sv_n} sinh viên`,
    `🎯 Mục đích: ${room.gc}`,
    `👤 MSSV: ${student.username}`,
    `⏰ Thời gian: ${timestamp}`,
  ].join("\n");

  return sendTelegram(env, message);
}

// ==============================
// CTU LOGIN + BOOKING
// ==============================

async function book(student, room) {
  const jar = new CookieJar();

  // Bước 1: Khởi tạo phiên
  const init = await send("", jar);

  if (!init.ok) {
    return {
      success: false,
      stage: "session",
      status: init.status,
      message: "Không khởi tạo được session",
    };
  }

  // Bước 2: Đăng nhập
  const login = await send("dangnhap.php", jar, {
    txtusername: student.username,
    txtpassword: student.password,
  });

  const loginText = await login.text();

  if (!login.ok || !notice(loginText, LOGIN_OK)) {
    return {
      success: false,
      stage: "login",
      status: login.status,
      message: "Đăng nhập thất bại",
    };
  }

  // Bước 3: Đặt phòng
  const response = await send(
    "dangky.php",
    jar,
    room
  );

  const html = await response.text();

  const success =
    response.ok && notice(html, BOOKING_OK);

  return {
    success,
    stage: "booking",
    status: response.status,
    message: success
      ? BOOKING_OK
      : "Không xác nhận được đăng ký thành công",
  };
}

// ==============================
// EXECUTE BOOKING JOBS
// ==============================

async function run(env) {
  if (!configuration.enabled) {
    return {
      disabled: true,
      message: "Set enabled=true in config/bookings.json",
    };
  }

  const tasks = plan();

  if (configuration.dryRun) {
    return {
      dryRun: true,
      total: tasks.length,
      tasks,
    };
  }

  if (!env.BOOKINGS) {
    throw new Error("Missing BOOKINGS KV binding");
  }

  const students = getStudents(env);
  const results = [];

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const key = bookingKey(task);

    // Bỏ qua lượt đặt đã thành công trước đó
    if (await env.BOOKINGS.get(key)) {
      results.push({
        ...task,
        success: true,
        skipped: "already-booked",
      });

      continue;
    }

    const student = students[task.studentId];

    if (!student?.username || !student?.password) {
      results.push({
        ...task,
        success: false,
        stage: "configuration",
        message: "Missing student credentials",
      });

      continue;
    }

    try {
      const result = await book(student, task.room);

      const entry = {
        ...task,
        ...result,
      };

      results.push(entry);

      if (result.success) {
        // Ghi nhận đặt phòng thành công
        try {
          await env.BOOKINGS.put(
            key,
            JSON.stringify({
              at: new Date().toISOString(),
              job: task.job,
              studentId: task.studentId,
              username: student.username,
            })
          );
        } catch (error) {
          console.error(
            "KV write failed:",
            error.message
          );
        }

        // Gửi Telegram ngay sau khi đặt thành công
        try {
          entry.telegramSent =
            await notifyBookingSuccess(
              env,
              task,
              student
            );

          console.log(
            `Telegram notification: ${student.username}, room ${task.room.id_p}`
          );
        } catch (error) {
          entry.telegramSent = false;

          console.error(
            "Telegram notification failed:",
            error.message
          );
        }
      }
    } catch (error) {
      results.push({
        ...task,
        success: false,
        stage: "network",
        message: error?.name || "network-error",
      });
    }

    // Giãn cách giữa các request
    if (
      i < tasks.length - 1 &&
      configuration.delayMs > 0
    ) {
      await new Promise(resolve =>
        setTimeout(resolve, configuration.delayMs)
      );
    }
  }

  return {
    total: tasks.length,
    success: results.filter(
      r => r.success && !r.skipped
    ).length,
    failed: results.filter(
      r => !r.success
    ).length,
    skipped: results.filter(
      r => r.skipped
    ).length,
    results,
    timestamp: new Date().toISOString(),
  };
}

// ==============================
// API AUTHENTICATION
// ==============================

function authorized(request, env) {
  if (!env.API_KEY) return false;

  return (
    request.headers.get("Authorization") ===
    `Bearer ${env.API_KEY}`
  );
}

// ==============================
// CLOUDFLARE WORKER
// ==============================

export default {
  // HTTP endpoints
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/") {
      return new Response("CTU Room Worker");
    }

    if (!authorized(request, env)) {
      return Response.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Xem danh sách đặt phòng
    if (
      pathname === "/plan" &&
      request.method === "GET"
    ) {
      try {
        return Response.json({
          enabled: configuration.enabled,
          dryRun: configuration.dryRun,
          tasks: plan(),
        });
      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 400 }
        );
      }
    }

    // Chạy đặt phòng thủ công
    if (
      pathname === "/run" &&
      request.method === "POST"
    ) {
      try {
        const result = await run(env);

        return Response.json(result);
      } catch (error) {
        return Response.json(
          { error: error.message },
          { status: 500 }
        );
      }
    }

    return Response.json(
      { error: "Not found" },
      { status: 404 }
    );
  },

  // Tự động chạy bằng Cron Trigger
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      run(env)
        .then(result => {
          console.log(
            "Scheduled run:",
            JSON.stringify(result)
          );
        })
        .catch(error => {
          console.error(
            "Scheduled run failed:",
            error.message
          );
        })
    );
  },
};

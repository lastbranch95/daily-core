/*
  Daily Core Task Storage API - Supabase bridge v0.1
  --------------------------------------------------
  目的：Daily Core本体は DailyTaskStorage だけを呼び、
        localStorage版 / Supabase版を差し替えられるようにする。

  使い方：
    1. HTMLで Supabase JS CDN を先に読み込む
    2. window.DAILY_CORE_SUPABASE_URL / ANON_KEY を設定する
    3. このファイルを taskStorage.js の代わりに読み込む

  注意：
    既存Daily Coreは同期関数前提なので、CRUDはまずローカルstateを即更新し、
    Supabase保存は裏で実行する「楽観更新」にしている。
*/
(function () {
  const TABLE_NAME = "daily_tasks";

  let client = null;
  let online = false;
  let currentUser = null;
  let currentUserId = null;

  function ensureTaskList(state) {
    if (!state || !Array.isArray(state.tasks)) {
      throw new Error("DailyTaskStorage: state.tasks が見つかりません。");
    }
    return state.tasks;
  }

  function toDbTask(task) {
    return {
      id: task.id,
      user_id: currentUserId,
      title: task.title || "",
      category: task.category || "その他",
      priority: task.priority || "should",
      schedule: task.schedule || "once",
      date: task.date || null,
      start_date: task.startDate || task.date || null,
      weekday: Number.isFinite(Number(task.weekday)) ? Number(task.weekday) : null,
      month_day: task.monthDay || null,
      interval_days: Number(task.intervalDays || 7),
      notify: Boolean(task.notify),
      notify_time: task.notifyTime || null,
      url: task.url || "",
      note: task.note || "",
      active: task.active !== false,
      task_order: Number.isFinite(Number(task.order)) ? Number(task.order) : Date.now(),
      created_at: task.createdAt || new Date().toISOString(),
      deleted_at: task.deletedAt || null
    };
  }

  function fromDbTask(row) {
    return {
      id: row.id,
      title: row.title || "",
      url: row.url || "",
      note: row.note || "",
      category: row.category || "その他",
      priority: row.priority || "should",
      schedule: row.schedule || "once",
      date: row.date || "",
      startDate: row.start_date || row.date || "",
      weekday: Number.isFinite(Number(row.weekday)) ? Number(row.weekday) : 0,
      monthDay: row.month_day || "1",
      intervalDays: Number(row.interval_days || 7),
      notify: Boolean(row.notify),
      notifyTime: row.notify_time ? String(row.notify_time).slice(0, 5) : "",
      active: row.active !== false,
      order: Number.isFinite(Number(row.task_order)) ? Number(row.task_order) : Date.now(),
      createdAt: row.created_at || new Date().toISOString(),
      deletedAt: row.deleted_at || null
    };
  }

  function logSyncError(label, error) {
    console.error(`[DailyTaskStorage Supabase] ${label}`, error);
  }

  function initClient() {
    const url = window.DAILY_CORE_SUPABASE_URL;
    const anonKey = window.DAILY_CORE_SUPABASE_ANON_KEY;

    if (!url || !anonKey || !window.supabase || !window.supabase.createClient) {
      console.warn("DailyTaskStorage: Supabase設定が未入力です。local stateのみで動作します。");
      online = false;
      return null;
    }

    client = window.supabase.createClient(url, anonKey);
    online = true;
    return client;
  }

  async function init(state) {
    ensureTaskList(state);
    const supabase = initClient();
    if (!supabase) {
      return { online: false, signedIn: false, count: state.tasks.length };
    }

    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();

    if (sessionError) {
      online = false;
      currentUser = null;
      currentUserId = null;
      logSyncError("セッション取得に失敗。localStorageのtasksで起動します。", sessionError);
      return { online: false, signedIn: false, count: state.tasks.length, error: sessionError };
    }

    currentUser = sessionData?.session?.user || null;
    currentUserId = currentUser?.id || null;

    if (!currentUserId) {
      online = false;
      return { online: false, signedIn: false, count: state.tasks.length };
    }

    const { data, error } = await supabase
      .from(TABLE_NAME)
      .select("*")
      .is("deleted_at", null)
      .order("task_order", { ascending: true });

    if (error) {
      online = false;
      logSyncError("初期取得に失敗。localStorageのtasksで起動します。", error);
      return { online: false, signedIn: true, count: state.tasks.length, error };
    }

    online = true;
    state.tasks = (data || []).map(fromDbTask).filter(task => task.id && task.title);
    return { online: true, signedIn: true, count: state.tasks.length };
  }

  async function signIn(email, password) {
    const supabase = initClient();
    if (!supabase) {
      throw new Error("Supabase設定が未入力です。");
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      online = false;
      currentUser = null;
      currentUserId = null;
      throw error;
    }

    currentUser = data?.user || data?.session?.user || null;
    currentUserId = currentUser?.id || null;
    online = Boolean(currentUserId);
    return currentUser;
  }

  async function signOut() {
    const supabase = initClient();
    if (!supabase) return;

    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }

    online = false;
    currentUser = null;
    currentUserId = null;
  }

  function getAuthState() {
    return {
      online,
      signedIn: Boolean(currentUserId),
      user: currentUser,
      userId: currentUserId,
      email: currentUser?.email || ""
    };
  }

  function getTasks(state) {
    return ensureTaskList(state);
  }

  function getTaskById(state, id) {
    return ensureTaskList(state).find(task => task.id === id) || null;
  }

  function saveTask(state, task) {
    if (!task || !task.id) {
      throw new Error("DailyTaskStorage.saveTask: task.id が必要です。");
    }

    ensureTaskList(state).push(task);

    if (online && client && currentUserId) {
      client.from(TABLE_NAME)
        .upsert(toDbTask(task), { onConflict: "id" })
        .then(({ error }) => {
          if (error) logSyncError("saveTask失敗", error);
        });
    }

    return task;
  }

  function updateTask(state, nextTask) {
    if (!nextTask || !nextTask.id) {
      throw new Error("DailyTaskStorage.updateTask: task.id が必要です。");
    }

    const tasks = ensureTaskList(state);
    const index = tasks.findIndex(task => task.id === nextTask.id);
    const merged = index < 0 ? nextTask : { ...tasks[index], ...nextTask };

    if (index < 0) {
      tasks.push(merged);
    } else {
      tasks[index] = merged;
    }

    if (online && client && currentUserId) {
      client.from(TABLE_NAME)
        .upsert(toDbTask(merged), { onConflict: "id" })
        .then(({ error }) => {
          if (error) logSyncError("updateTask失敗", error);
        });
    }

    return merged;
  }

  function deleteTask(state, id) {
    const tasks = ensureTaskList(state);
    const before = tasks.length;
    state.tasks = tasks.filter(task => task.id !== id);
    const deleted = before !== state.tasks.length;

    if (deleted && online && client) {
      client.from(TABLE_NAME)
        .update({ deleted_at: new Date().toISOString(), active: false })
        .eq("id", id)
        .then(({ error }) => {
          if (error) logSyncError("deleteTask失敗", error);
        });
    }

    return deleted;
  }

  function replaceTasks(state, tasks) {
    if (!Array.isArray(tasks)) {
      throw new Error("DailyTaskStorage.replaceTasks: tasks は配列である必要があります。");
    }
    state.tasks = tasks;

    if (online && client && currentUserId) {
      const rows = tasks.map(toDbTask);
      client.from(TABLE_NAME)
        .upsert(rows, { onConflict: "id" })
        .then(({ error }) => {
          if (error) logSyncError("replaceTasks失敗", error);
        });
    }

    return state.tasks;
  }

  window.DailyTaskStorage = {
    mode: "supabase-auth",
    init,
    signIn,
    signOut,
    getAuthState,
    getTasks,
    getTaskById,
    saveTask,
    updateTask,
    deleteTask,
    replaceTasks
  };
})();

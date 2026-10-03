// scratch.mit.edu のタブ内で動く。ログイン済みのブラウザ状態(Cookie)をそのまま使うので、セッションIDには触れない。
(() => {
  if (window.__studioInviterLoaded) return;
  window.__studioInviterLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = {
    phase: "idle", // idle | collecting | adding | filtering | ready | running | finished
    users: [], done: 0, total: 0, stop: false,
    counts: { invited: 0, skipped: 0, notfound: 0, failed: 0 },
    log: [], busyMessage: "", progressText: ""
  };

  const log = (m) => { state.log.push(m); if (state.log.length > 500) state.log.shift(); };
  const csrf = () => (document.cookie.match(/(?:^|;\s*)scratchcsrftoken=([^;]+)/) || [])[1] || "";

  async function getMe() {
    try {
      const r = await fetch("/session/", { headers: { "x-requested-with": "XMLHttpRequest" }, credentials: "include" });
      const j = await r.json();
      return (j && j.user && j.user.username) || null;
    } catch { return null; }
  }

  async function fetchAllStudio(kind, id) {
    const out = [];
    for (let offset = 0; ; offset += 40) {
      const r = await fetch(`https://api.scratch.mit.edu/studios/${encodeURIComponent(id)}/${kind}/?limit=40&offset=${offset}`);
      if (!r.ok) throw new Error(`${kind} の取得に失敗 (HTTP ${r.status})。スタジオIDを確認してください`);
      const arr = await r.json();
      out.push(...arr.map((u) => u.username));
      if (arr.length < 40) break;
      await sleep(300);
    }
    return out;
  }

  async function fetchAllRelation(username, kind) {
    const out = [];
    const u = encodeURIComponent(username);
    for (let offset = 0; ; offset += 40) {
      const r = await fetch(`https://api.scratch.mit.edu/users/${u}/${kind}/?limit=40&offset=${offset}`);
      if (r.status === 404) throw new Error(`ユーザー「${username}」が見つかりません`);
      if (r.status === 429) throw new Error("Scratch API の送信制限 (429) にかかりました。時間を置いてください");
      if (!r.ok) throw new Error(`${kind} の取得に失敗しました (HTTP ${r.status})`);
      const arr = await r.json();
      out.push(...arr.map((x) => x.username));
      if (arr.length < 40) break;
      state.progressText = `${username} の ${kind} を取得中… ${out.length}人`;
      await sleep(300);
    }
    return out;
  }

  async function fetchProfile(username) {
    const r = await fetch(`https://api.scratch.mit.edu/users/${encodeURIComponent(username)}/`);
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error("プロフィール取得中に Scratch API の送信制限 (429) にかかりました。時間を置いてください");
    if (!r.ok) throw new Error(`ユーザー「${username}」のプロフィール取得に失敗 (HTTP ${r.status})`);
    return r.json();
  }

  function uniqueAppend(names, me) {
    const seen = new Set(state.users.map((n) => n.toLowerCase()));
    const meKey = me ? me.toLowerCase() : null;
    let added = 0;
    for (const name of names) {
      if (!name) continue;
      const key = name.toLowerCase();
      if (meKey && key === meKey) continue;
      if (seen.has(key)) continue;
      seen.add(key); state.users.push(name); added++;
    }
    return added;
  }

  async function collect(sourceId) {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    state.phase = "collecting"; state.log = []; state.busyMessage = "元スタジオの管理者・キュレーターを取得中…"; state.progressText = "";
    try {
      const me = await getMe();
      const managers = await fetchAllStudio("managers", sourceId);
      const curators = await fetchAllStudio("curators", sourceId);
      const seen = new Set(), users = [];
      for (const n of [...managers, ...curators]) {
        const k = n.toLowerCase();
        if (seen.has(k) || (me && k === me.toLowerCase())) continue;
        seen.add(k); users.push(n);
      }
      state.users = users; state.phase = "ready"; state.busyMessage = ""; state.progressText = "";
      log(`取得: 管理者 ${managers.length}人 / キュレーター ${curators.length}人 → 重複と自分を除いて ${users.length}人`);
      return { ok: true };
    } catch (e) {
      state.phase = "idle"; state.busyMessage = ""; state.progressText = ""; log(`エラー: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function addRelation(username, kind, label) {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    state.phase = "adding"; state.busyMessage = `${username} の ${label} を取得中…`; state.progressText = "";
    try {
      const me = await getMe();
      const names = await fetchAllRelation(username, kind);
      const added = uniqueAppend(names, me);
      state.phase = "ready"; state.busyMessage = ""; state.progressText = "";
      log(`${username}: ${label} ${names.length}人を取得 → 新規 ${added}人を招待リストに追加しました`);
      return { ok: true, added };
    } catch (e) {
      state.phase = "ready"; state.busyMessage = ""; state.progressText = ""; log(`エラー: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function filterProfile(keywords) {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    const words = [...new Set(keywords.map((x) => String(x).trim().toLowerCase()).filter(Boolean))];
    if (!words.length) return { ok: false, error: "除外ワードがありません" };

    state.phase = "filtering";
    state.progressText = `除外ワード: ${words.join(", ")}`;
    const original = [...state.users], kept = [];
    let checked = 0, removed = 0;

    try {
      for (const name of original) {
        const profile = await fetchProfile(name);
        checked++;
        if (profile) {
          const p = profile.profile || {};
          const text = `${String(p.status || "")}\n${String(p.bio || "")}`.toLowerCase();
          const hit = words.find((w) => text.includes(w));
          if (hit) {
            removed++;
            log(`除外: ${name}（プロフィールに「${hit}」を検出）`);
          } else kept.push(name);
        } else kept.push(name);
        state.busyMessage = `プロフィールを調べています… ${checked}/${original.length}`;
        await sleep(120);
      }
      state.users = kept; state.phase = "ready"; state.busyMessage = ""; state.progressText = "";
      log(`プロフィール除外完了: ${original.length}人 → ${kept.length}人（${removed}人を除外）`);
      return { ok: true, checked, removed };
    } catch (e) {
      state.users = kept.concat(original.slice(checked));
      state.phase = "ready"; state.busyMessage = ""; state.progressText = "";
      log(`プロフィール除外を中断: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function excludeUsers(names) {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    const words = new Set(names.map((x) => String(x).trim().toLowerCase()).filter(Boolean));
    if (!words.size) return { ok: false, error: "除外するユーザー名がありません" };
    const before = state.users.length;
    state.users = state.users.filter((u) => !words.has(u.toLowerCase()));
    const removed = before - state.users.length;
    log(`ユーザー名指定で除外: ${removed}人を招待リストから削除しました`);
    return { ok: true, removed };
  }

  async function importUsers(names) {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    const me = await getMe();
    const meKey = me ? me.toLowerCase() : null;
    const seen = new Set(), list = [];
    for (const raw of names) {
      const name = String(raw).trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (meKey && key === meKey) continue;
      if (seen.has(key)) continue;
      seen.add(key); list.push(name);
    }
    state.users = list; state.phase = "ready";
    log(`招待リストを読み込みました: ${list.length}人`);
    return { ok: true, count: list.length };
  }

  async function removeInvalid() {
    if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) return { ok: false, error: "別の処理が実行中です" };
    if (!state.users.length) return { ok: false, error: "招待リストにユーザーがいません" };
    state.phase = "checking";
    const original = [...state.users], kept = [];
    let checked = 0, removed = 0;
    try {
      for (const name of original) {
        const profile = await fetchProfile(name);
        checked++;
        if (profile === null) {
          removed++;
          log(`除外: ${name}（ユーザーが存在しません）`);
        } else kept.push(name);
        state.busyMessage = `存在確認中… ${checked}/${original.length}`;
        await sleep(120);
      }
      state.users = kept; state.phase = "ready"; state.busyMessage = "";
      log(`存在しないユーザーの削除完了: ${original.length}人 → ${kept.length}人（${removed}人を除外）`);
      return { ok: true, checked, removed };
    } catch (e) {
      state.users = kept.concat(original.slice(checked));
      state.phase = "ready"; state.busyMessage = "";
      log(`存在確認を中断: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  async function run(targetId, users, delayMs) {
    state.phase = "running"; state.stop = false; state.done = 0; state.total = users.length;
    state.counts = { invited: 0, skipped: 0, notfound: 0, failed: 0 };
    let consecutiveFail = 0;
    log(`招待開始: 先=${targetId} / ${users.length}人 / 間隔 ${delayMs / 1000}秒`);

    for (const name of users) {
      if (state.stop) { log("停止しました"); break; }
      let processed = true, halt = false;
      try {
        const r = await fetch(`https://scratch.mit.edu/site-api/users/curators-in/${targetId}/invite_curator/?usernames=${encodeURIComponent(name)}`, {
          method: "PUT", credentials: "include",
          headers: { "x-csrftoken": csrf(), "x-requested-with": "XMLHttpRequest" }
        });
        if (r.status === 404) { state.counts.notfound++; consecutiveFail = 0; log(`× ${name}: ユーザーが見つかりません (404)`); }
        else if (r.status === 429) { processed = false; halt = true; log("! 429: 送信制限にかかったため停止しました。時間を置いてください"); }
        else if (r.status === 401 || r.status === 403) { processed = false; halt = true; log(`! ${r.status}: ログイン切れ、または招待先スタジオの管理権限がありません。停止しました`); }
        else if (r.ok) {
          let body = null; try { body = await r.json(); } catch {}
          if (body && body.status === "success") {
            state.counts.invited++; consecutiveFail = 0; log(`✓ ${name}: 招待しました`);
            const idx = state.users.findIndex((u) => u.toLowerCase() === name.toLowerCase());
            if (idx !== -1) state.users.splice(idx, 1);
          }
          else if (body && body.status === "error") { state.counts.skipped++; consecutiveFail = 0; log(`- ${name}: ${body.message || "エラー"}`); }
          else { state.counts.failed++; consecutiveFail++; log(`? ${name}: 想定外の応答`); }
        } else { state.counts.failed++; consecutiveFail++; log(`! ${name}: HTTP ${r.status}`); }
      } catch (e) { state.counts.failed++; consecutiveFail++; log(`! ${name}: 通信エラー (${e.message})`); }
      if (processed) state.done++;
      if (halt) break;
      if (consecutiveFail >= 3) { log("! 3回連続で失敗したため停止しました"); break; }
      await sleep(delayMs);
    }

    state.phase = "finished";
    const c = state.counts;
    log(`終了: 招待 ${c.invited} / スキップ ${c.skipped} / 見つからない ${c.notfound} / 失敗 ${c.failed}`);
  }

  chrome.runtime.onMessage.addListener((msg, _s, send) => {
    if (msg.type === "collect") { collect(msg.sourceId).then(send); return true; }
    if (msg.type === "addFollowing") { addRelation(msg.username, "following", "フォロー中").then(send); return true; }
    if (msg.type === "addFollowers") { addRelation(msg.username, "followers", "フォロワー").then(send); return true; }
    if (msg.type === "filterProfile") { filterProfile(Array.isArray(msg.keywords) ? msg.keywords : []).then(send); return true; }
    if (msg.type === "excludeUsers") { excludeUsers(Array.isArray(msg.keywords) ? msg.keywords : []).then(send); return true; }
    if (msg.type === "importUsers") { importUsers(Array.isArray(msg.users) ? msg.users : []).then(send); return true; }
    if (msg.type === "removeInvalid") { removeInvalid().then(send); return true; }
    if (msg.type === "clearUsers") {
      if (["running", "collecting", "adding", "filtering", "checking"].includes(state.phase)) { send({ ok: false, error: "別の処理が実行中です" }); return; }
      state.users = []; state.phase = "idle"; state.log = []; state.busyMessage = ""; state.progressText = ""; send({ ok: true }); return;
    }
    if (msg.type === "start") {
      if (state.phase === "running") { send({ ok: false, error: "実行中です" }); return; }
      if (!Array.isArray(msg.users) || !msg.users.length) { send({ ok: false, error: "招待対象がありません" }); return; }
      run(msg.targetId, msg.users, msg.delayMs); send({ ok: true }); return;
    }
    if (msg.type === "stop") { state.stop = true; send({ ok: true }); return; }
    if (msg.type === "status") send(state);
  });
})();

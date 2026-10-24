/* 家計簿 クラウド保存（Supabase）。合言葉から作った鍵で記録を分け、決められた関数だけを呼びます。 */
(function () {
  'use strict';
  var SB_URL = 'https://bjrlqzfzwowrqtyfkgsd.supabase.co';
  var SB_KEY = 'sb_publishable_4YSEh-uc6lRhz9HIsBarpQ_-Yw_vl8P';
  var STORE = 'kakeibo-sync-key', DIRTY = 'kakeibo-sync-dirty';

  var slot = document.getElementById('syncSlot');
  var app = window.kakeiboApp;
  if (!slot || !app) return;

  function $(id) { return document.getElementById(id); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function J(x) { return JSON.stringify(x); }

  var key = null, snap = null, chain = Promise.resolve(), inflight = 0, hadError = false;
  var status = 'out', msg = '', lastAt = null, lastPull = 0, confirmOut = false, mergeCtx = null;

  /* ---------- API ---------- */
  function rpc(fn, args) {
    return fetch(SB_URL + '/rest/v1/rpc/' + fn, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(args)
    }).then(function (r) {
      if (!r.ok) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          var e = new Error(j.message || ('HTTP ' + r.status)); e.code = j.code || ''; e.status = r.status; throw e;
        });
      }
      return r.text().then(function (t) { return t ? JSON.parse(t) : null; });
    });
  }
  function friendly(e) {
    if (!e) return '';
    if (e.code === '23505') return 'その合言葉はすでに使われています。別の合言葉にしてください。';
    if (e.code === '54000') return '登録できる数の上限に達しています。';
    if (e.code === 'P0002') return 'クラウドの記録が見つかりません。';
    if (e.code === '22023') return '入力が正しくないため保存できませんでした。';
    if (e instanceof TypeError) return 'ネットワークに接続できません。';
    return '保存できませんでした。しばらくしてからもう一度お試しください。';
  }

  /* 合言葉 → 鍵（PBKDF2 → 16進64桁）。合言葉そのものは送りません。 */
  function deriveKey(pass) {
    var enc = new TextEncoder();
    return crypto.subtle.importKey('raw', enc.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveBits'])
      .then(function (k) {
        return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('kakeibo-v1'), iterations: 200000 }, k, 256);
      }).then(function (bits) {
        return Array.prototype.map.call(new Uint8Array(bits), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      });
  }

  /* ---------- data helpers ---------- */
  function pack(d) {
    return {
      goal: d.goal || 0,
      cats: d.cats.map(function (c) { return { id: c.id, name: c.name, color: c.color }; }),
      tx: d.tx.filter(function (t) { return !t.sample; }).map(function (t) { return { id: t.id, date: t.date, cat: t.cat, amount: t.amount, memo: t.memo || '' }; }),
      balances: d.balances || {}
    };
  }
  function toData(p) { return { cats: p.cats, tx: p.tx, goal: p.goal, balances: p.balances }; }
  function fromRemote(r) {
    return {
      cats: (r.cats || []).map(function (c) { return { id: c.id, name: c.name, color: c.color }; }),
      tx: (r.tx || []).map(function (t) { return { id: t.id, date: t.date, cat: t.cat, amount: t.amount, memo: t.memo || '' }; }),
      goal: r.goal || 0,
      balances: r.balances || {}
    };
  }
  function byId(a) { var m = {}; a.forEach(function (x) { m[x.id] = x; }); return m; }
  function diffOps(a, b) {
    var ops = [], id;
    var ca = byId(a.cats), cb = byId(b.cats), ta = byId(a.tx), tb = byId(b.tx);
    for (id in cb) if (!ca[id] || J(ca[id]) !== J(cb[id])) ops.push(['kakeibo_put_cat', { p_id: id, p_name: cb[id].name, p_color: cb[id].color }]);
    for (id in tb) if (!ta[id] || J(ta[id]) !== J(tb[id])) ops.push(['kakeibo_put_tx', { p_id: id, p_date: tb[id].date, p_cat: tb[id].cat, p_amount: tb[id].amount, p_memo: tb[id].memo }]);
    for (id in ta) if (!tb[id]) ops.push(['kakeibo_del_tx', { p_id: id }]);
    for (id in ca) if (!cb[id]) ops.push(['kakeibo_del_cat', { p_id: id }]);
    if (a.goal !== b.goal) ops.push(['kakeibo_set_goal', { p_goal: b.goal }]);
    var k;
    for (k in b.balances) if (a.balances[k] !== b.balances[k]) ops.push(['kakeibo_set_balance', { p_ym: k, p_amount: b.balances[k] }]);
    for (k in a.balances) if (!(k in b.balances)) ops.push(['kakeibo_set_balance', { p_ym: k, p_amount: null }]);
    return ops;
  }
  function runOps(ops) {
    return ops.reduce(function (p, op) {
      return p.then(function () {
        var args = { p_key: key };
        for (var k in op[1]) args[k] = op[1][k];
        return rpc(op[0], args);
      });
    }, Promise.resolve());
  }

  /* ---------- status bar ---------- */
  function setStatus(s, m) { status = s; msg = m || ''; updateBar(); }
  function hhmm(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function updateBar() {
    var inn = !!key, t;
    if (!inn) t = 'クラウド保存：未ログイン（この端末の中だけに保存されています）';
    else if (confirmOut) t = 'ログアウトすると、この端末の表示を消します。クラウドの記録は消えません。';
    else if (status === 'busy') t = 'クラウド保存：保存中…';
    else if (status === 'err') t = 'クラウド保存：' + (msg || '送れませんでした。') + (hadError ? '（未送信の変更があります）' : '');
    else t = 'クラウド保存：同期済み' + (lastAt ? '（' + hhmm(lastAt) + '）' : '');
    $('syncText').textContent = t;
    $('syncOpen').hidden = inn;
    $('syncPull').hidden = !inn || confirmOut || hadError;
    $('syncRetry').hidden = !inn || confirmOut || status !== 'err';
    $('syncOut').hidden = !inn || confirmOut;
    $('outYes').hidden = !inn || !confirmOut;
    $('outNo').hidden = !inn || !confirmOut;
  }
  function setDirty(v) { lsSet(DIRTY, v ? '1' : null); }
  function ok() { hadError = false; setDirty(false); lastAt = new Date(); setStatus('ok'); }

  /* ---------- sync ---------- */
  function enqueue(ops) {
    if (!ops.length) return;
    inflight++; setStatus('busy');
    chain = chain.then(function () { return runOps(ops); }).then(function () {
      inflight--; if (!inflight) { if (hadError) setStatus('err', msg); else ok(); }
    }, function (e) {
      inflight--; hadError = true; setDirty(true); setStatus('err', friendly(e));
    });
  }
  function changed(d) {
    if (!key || !snap) return;
    var cur = pack(d), ops = diffOps(snap, cur);
    snap = cur; enqueue(ops);
  }
  function pull() {
    setStatus('busy');
    return chain.then(function () { return rpc('kakeibo_load', { p_key: key }); }).then(function (r) {
      if (!r) { var e = new Error('not found'); e.code = 'P0002'; throw e; }
      var d = fromRemote(r); app.replace(d); snap = pack(d); lastPull = Date.now(); ok();
    }).catch(function (e) { setStatus('err', friendly(e)); });
  }
  function resync() {
    setStatus('busy');
    return chain.then(function () { return rpc('kakeibo_load', { p_key: key }); }).then(function (r) {
      if (!r) { var e = new Error('not found'); e.code = 'P0002'; throw e; }
      var cur = pack(app.get());
      return runOps(diffOps(fromRemote(r), cur)).then(function () { snap = cur; ok(); });
    }).catch(function (e) { hadError = true; setDirty(true); setStatus('err', friendly(e)); });
  }

  /* ---------- panel ---------- */
  function showPanel(v) { $('syncPanel').hidden = !v; if (v) { $('syncErr').textContent = ''; $('syncPass').focus(); } }
  function panelErr(t) { $('syncErr').textContent = t; }
  function busy(v) { $('syncLogin').disabled = v; $('syncCreate').disabled = v; }
  function passOk() {
    var p = $('syncPass').value;
    if (Array.from(p).length < 6) { panelErr('合言葉は6文字以上で入力してください。'); return null; }
    panelErr(''); return p;
  }
  function finishLogin(k, r) {
    key = k; lsSet(STORE, k);
    var d = fromRemote(r); app.replace(d); snap = pack(d); lastPull = Date.now();
    $('syncPass').value = ''; mergeCtx = null; $('syncMerge').hidden = true; showPanel(false);
    ok();
  }
  function localCount() { return pack(app.get()).tx.length; }

  $('syncOpen').addEventListener('click', function () { showPanel($('syncPanel').hidden); });
  $('syncClose').addEventListener('click', function () { showPanel(false); });

  $('syncPanel').addEventListener('submit', function (e) {
    e.preventDefault();
    var p = passOk(); if (!p) return;
    busy(true); panelErr('');
    deriveKey(p).then(function (k) {
      return rpc('kakeibo_load', { p_key: k }).then(function (r) {
        if (!r) { panelErr('その合言葉の家計簿が見つかりません。はじめての方は「はじめて使う」を押してください。'); return; }
        if (localCount() > 0) {
          mergeCtx = { k: k, r: r };
          $('syncMergeText').textContent = 'この端末に、あなたが入力した記録が ' + localCount() + ' 件あります。クラウドに追加しますか？ 追加しない場合、この端末の記録はクラウドの内容に置き換わります。';
          $('syncMerge').hidden = false; showPanel(false);
          return;
        }
        finishLogin(k, r);
      });
    }).catch(function (er) { panelErr(friendly(er)); }).then(function () { busy(false); });
  });
  $('mergeAdd').addEventListener('click', function () {
    if (!mergeCtx) return;
    var c = mergeCtx; busy(true);
    rpc('kakeibo_import', { p_key: c.k, p_data: pack(app.get()) })
      .then(function () { return rpc('kakeibo_load', { p_key: c.k }); })
      .then(function (r) { finishLogin(c.k, r); })
      .catch(function (er) { $('syncMerge').hidden = true; showPanel(true); panelErr(friendly(er)); })
      .then(function () { busy(false); });
  });
  $('mergeSkip').addEventListener('click', function () { if (mergeCtx) finishLogin(mergeCtx.k, mergeCtx.r); });
  $('mergeCancel').addEventListener('click', function () { mergeCtx = null; $('syncMerge').hidden = true; });

  $('syncCreate').addEventListener('click', function () {
    var p = passOk(); if (!p) return;
    busy(true); panelErr('');
    deriveKey(p).then(function (k) {
      var cur = pack(app.get());
      return rpc('kakeibo_create', { p_key: k, p_data: cur }).then(function () {
        key = k; lsSet(STORE, k);
        var d = toData(cur); app.replace(d); snap = pack(d); lastPull = Date.now();
        $('syncPass').value = ''; showPanel(false); ok();
      });
    }).catch(function (er) { panelErr(friendly(er)); }).then(function () { busy(false); });
  });

  $('syncPull').addEventListener('click', function () { pull(); });
  $('syncRetry').addEventListener('click', function () { resync(); });
  $('syncOut').addEventListener('click', function () { confirmOut = true; updateBar(); });
  $('outNo').addEventListener('click', function () { confirmOut = false; updateBar(); });
  $('outYes').addEventListener('click', function () {
    confirmOut = false; key = null; snap = null; hadError = false; lsSet(STORE, null); setDirty(false);
    app.reset(); setStatus('out');
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && key && !hadError && !inflight && Date.now() - lastPull > 20000) pull();
  });

  window.kakeiboSync = { changed: changed };

  /* ---------- start ---------- */
  var saved = lsGet(STORE);
  if (saved && /^[0-9a-f]{64}$/.test(saved)) {
    key = saved; snap = pack(app.get()); updateBar();
    if (lsGet(DIRTY) === '1') { hadError = true; resync(); } else { pull(); }
  } else { updateBar(); }
})();

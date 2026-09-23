/* ============================================================
   Protein Sync ランダム検証ハーネス（ブラウザのコンソールに貼って使う）

   使い方
     1. index.html をブラウザで開く
        （file:///.../protein-sync/index.html でも、公開ページでも可）
     2. DevTools のコンソールを開き、このファイルの中身を全部貼って Enter
     3. コンソールで実行する

          PSCheck.runAsync(1000)       1,000ケース（画面を止めずに回す。**こちらを推奨**）
          PSCheck.progress             途中経過（done / n / fails）
          PSCheck.run(1000)            同じ検証を同期で回す（1,000ケースで20分以上固まる）
          PSCheck.run(200)             件数を指定
          PSCheck.run(1000, 12345)     乱数の種を指定（失敗を再現するとき）
          PSCheck.only(12345, 37)      種12345の37番目のケースだけを流して画面に残す

     4. 終わったら必ず  PSCheck.restore()  を実行する
        （Date の差し替えを戻し、localStorage を検証前の内容に書き戻す。
          そのあとページを再読み込みすること）

   jsdom は使わない。実物の DOM で動かすのが目的なので、
   ブラウザに貼って実行する前提のファイルにしてある。
   このファイルは開発用で、index.html はこれに一切依存しない。

   1,000ケースで数十秒かかる（1ケースごとに updateLive() と render() を通し、
   週の表7日ぶん＋運動の前提7通りも計算しているため）。
   途中経過は100ケースごとにコンソールへ出す。

   ------------------------------------------------------------
   判定している項目
     1  例外が出ないこと
     2  画面に NaN / undefined が出ないこと（④⑤と週の2表）
     3  目標たんぱく質が運動量で動かないこと（＝体重×基本係数のまま）
     4  1日の上限：卵2個（メニューの卵込み）／プロテインの杯数（1回 MAX_PER_SERVE 杯×回数）／
        ご飯（autoMax かつ1食 slotLimit×自宅の食事数）／オリーブオイルの autoMax／候補の fillMax
     5  自動計算の線（自動計算ぶんを0にした状態で線の内側だった日だけを見る）
        候補と油は 食塩7.5g・飽和脂肪酸15g ／ ご飯は上限の17g ／ 上限17gは絶対に越えない
     6  総負荷量＝チェックの入っている種目だけの合計
     7  ④の「②の運動は今日の分が未入力です」が、未入力のときだけ出ること
     8  ⑤のプロテイン1回目の行に時刻が出ていないこと（粉を摂らない日は行そのものが出ない）
     9  ⑤の時刻が昇順であること（「翌00:30」は翌日として +24時間で見る）
     10 再計算の冪等性（続けて render() しても結果が変わらない）
     11 ①の「必要エネルギーの補正」が必要エネルギーにそのまま乗ること
     12 プロテインの杯数も飽和脂肪酸15gの線で止まること（最低杯数と手動指定は除く）
     13 ④の「残りを補う提案」も 食塩7.5g・飽和15g の線を越えないこと
     14 ⑤が中身を隠していないこと（③の数量>0の品目と、④の提案の品目が全部出ている）
     15 エネルギーが必要量を ENERGY_BAD 以上下回る日は、④が「足りない」と出していること

   振っている状態（v.168で追加）
     ・品目の「使う／使わない」を無作為に外す（3割。5%は「すべて外す」に近い状態）
     ・自由入力の品目を無作為に足す（2割。栄養が偏った品目も作る）
     ここを振っていなかったため、**標準の型から外れた日の不具合を取りこぼしていた**。
     実際に、⑤が④の提案を隠す不具合（v.167で修正）と、
     提案が食塩・飽和を見ていない不具合（v.168で修正）は、利用者が食べて見つけている。
   ============================================================ */
(() => {
'use strict';

const RealDate = Date;
const SAVED = (() => { try { return localStorage.getItem('savas-calc-v3'); } catch(e){ return null; } })();

// 種を指定できる乱数（失敗したケースを再現できるようにするため）
const mulberry32 = a => () => {
  a |= 0; a = a + 0x6D2B79F5 | 0;
  let t = Math.imul(a ^ a >>> 15, 1 | a);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
};

const $$ = id => document.getElementById(id);
const setVal = (id, v) => { const el = $$(id); if(el) el.value = v; };
const setChk = (id, v) => { const el = $$(id); if(el) el.checked = !!v; };

/* 曜日を固定する。2026-09-13 は日曜なので、そこに idx 日を足す。 */
function setWeekday(idx){
  const base = new RealDate(2026, 8, 13 + idx);
  window.Date = class extends RealDate {
    constructor(...a){ a.length === 0 ? super(base.getTime()) : super(...a); }
    static now(){ return base.getTime(); }
  };
}

/* ---------- 1ケースぶんの入力を作る ---------- */
function makeCase(rnd, i){
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const c = {
    n:        i,
    weekday:  Math.floor(rnd() * 7),
    weight:   Math.round((50 + rnd() * 45) * 10) / 10,      // 50〜95kg
    height:   Math.round((150 + rnd() * 40) * 10) / 10,
    age:      20 + Math.floor(rnd() * 60),
    factor:   Math.round((1.2 + rnd() * 0.6) * 100) / 100,  // 1.20〜1.80
    meals:    pick(['3', '2l', '2b']),
    share:    pick([10, 20, 30, 40, 60, 100]),
    fix:      pick(['', '', '', 1, 2, 3, 99]),              // 空欄＝自動計算。99は上限超えの入力
    two:      rnd() < 0.7,
    rest:     rnd() < 0.3,
    detail:   rnd() < 0.5,
    kcalAdj:  pick([0, 0, 0, 200, -200, 600, -600]),   // ①の必要エネルギーの補正
    walk:     pick([0, 0, 5, 10, 12, 20, 25]),
    cycle:    pick([0, 0, 10, 20, 30, 40]),
    exOn:     EXERCISES.map(() => rnd() < 0.6),
    entered:  rnd() < 0.75,                                 // ③を今日の分として確定したか
    times:    pick([['07:00','12:00','18:00'], ['09:30','12:00','18:00'],
                    ['11:30','14:00','20:00'], ['06:00','','' ], ['', '12:00', '']]),
    // 3割のケースは、型に加えて手入力の品目も混ぜる
    manual:   rnd() < 0.3 ? {
                sk_gyudon:  rnd() < 0.3 ? 1 : 0,
                mt_gyumeshi:rnd() < 0.2 ? 1 : 0,
                mt_miso:    rnd() < 0.3 ? 1 : 0,
                egg:        Math.floor(rnd() * 4),           // 上限を超える値もわざと入れる
                saba_miso:  rnd() < 0.2 ? 1 : 0,
                katsuju:    rnd() < 0.15 ? 1 : 0
              } : null,
    otherP:   rnd() < 0.15 ? Math.round(rnd() * 40) : 0,
    /* 品目の「使う／使わない」。在庫が無い日・食べない品目がある日を作る。
       5%は「ほぼ全部外す」にして、提案も候補も作れない状態を通す。 */
    offAll:   rnd() < 0.05,
    off:      rnd() < 0.30 ? (() => {
                const ids = FOODS.filter(f => !f.custom).map(f => f.id);
                const k = 1 + Math.floor(rnd() * 12);
                const o = {};
                for(let j = 0; j < k; j++) o[ids[Math.floor(rnd() * ids.length)]] = true;
                return o;
              })() : null,
    /* 自由入力の品目。**栄養成分は利用者が手で書き写すので、偏った値もありうる**
       （実際に「1個で飽和脂肪酸4.5g」の菓子が登録された）。そこを振る。 */
    custom:   rnd() < 0.20 ? Array.from({length: 1 + Math.floor(rnd() * 2)}, (_, k) => ({
                name:  'テスト品目' + (k + 1),
                unit:  '個',
                p:     Math.round(rnd() * 25 * 10) / 10,
                kcal:  Math.round(rnd() * 400),
                fat:   Math.round(rnd() * 20 * 10) / 10,
                sat:   Math.round(rnd() * 10 * 10) / 10,
                carbG: Math.round(rnd() * 60 * 10) / 10,
                fiber: Math.round(rnd() * 5 * 10) / 10,
                salt:  Math.round(rnd() * 3 * 10) / 10,
                price: Math.round(rnd() * 500),
                qty:   1 + Math.floor(rnd() * 3)
              })) : null
  };
  return c;
}

function applyCase(c){
  setWeekday(c.weekday);
  setAutoOverride(null, false);     // 自動計算を全部オンに戻す
  applyDailyDefaults();             // ②をその曜日の型に戻す
  setVal('weight', c.weight); setVal('height', c.height); setVal('age', c.age);
  setVal('baseFactor', c.factor);   setVal('meals', c.meals);
  setVal('savasShare', c.share);    setVal('fixSpoons', c.fix);
  setChk('twoDoses', c.two); setChk('restSavas', c.rest); setChk('schedDetail', c.detail);
  setVal('kcalAdj', c.kcalAdj);
  setVal('walk', c.walk); setVal('cycle', c.cycle);
  setVal('breakfastTime', c.times[0]); setVal('lunchTime', c.times[1]); setVal('dinnerTime', c.times[2]);
  setVal('otherP', c.otherP);
  EXERCISES.forEach((e, i) => setChk('c_' + e.id, c.exOn[i]));
  if(c.manual) Object.keys(c.manual).forEach(id => { if($$('f_' + id)) setVal('f_' + id, c.manual[id]); });
  // ②を「今日の分として確定したか」。④の未入力表示を出し分ける
  exDate = c.entered ? todayKey() : '';

  /* 自由入力の品目を足す。**ケースごとに必ず消す**（消さないと FOODS と DOM が
     ケース数ぶん膨らんで、検証そのものが遅くなる）。 */
  c._customIds = [];
  if(c.custom) c.custom.forEach(o => { c._customIds.push(addCustomFood(o, o.qty).id); });

  // 品目の「使う／使わない」
  foodOff = {};
  if(c.offAll)   FOODS.forEach(f => { if($$('use_' + f.id)) foodOff[f.id] = true; });
  else if(c.off) Object.keys(c.off).forEach(id => { if($$('use_' + id)) foodOff[id] = true; });
  applyFoodUse();
}

/* ケースの後始末。足した品目を消し、チェックを全部オンに戻す。 */
function cleanupCase(c){
  (c._customIds || []).forEach(id => removeCustomFood(id));
  c._customIds = [];
  foodOff = {};
  applyFoodUse();
}

/* ---------- 判定 ---------- */
const TIME_RE = /(翌)?(\d{1,2}):(\d{2})/;
const minutesOf = txt => {
  const m = txt.match(TIME_RE);
  return m ? (m[1] ? 1440 : 0) + (+m[2]) * 60 + (+m[3]) : null;
};
// 結果のHTMLから、毎回変わる部分（最終更新の時刻）を落とす
const snapshot = () => $$('result').innerHTML.replace(/最終更新[^<]*/g, '');

function checkOne(c, fail){
  updateLive();
  render();

  const st  = readState();
  const ex  = calcFactor(st);
  const sv  = savasOf(st, ex);

  // 2. NaN / undefined
  const html = ['result', 'weekNutri', 'weekEnergy', 'weekPlan', 'schedule']
    .map(id => ($$(id) ? $$(id).innerHTML : '')).join('');
  const nan = html.match(/NaN|undefined/);
  if(nan) fail(`画面に ${nan[0]} が出ています`);

  // 3. 目標たんぱく質は体重×基本係数だけで決まり、運動量で動かない
  const want = r1(st.weight * st.baseFactor);
  if($$('oTarget').textContent.trim() !== want + ' g')
    fail(`目標P：画面 ${$$('oTarget').textContent.trim()} / 体重×係数 ${want} g`);
  const exAll = {}, exNone = {};
  EXERCISES.forEach(e => {
    exAll[e.id]  = Object.assign({}, st.ex[e.id], {on:true});
    exNone[e.id] = Object.assign({}, st.ex[e.id], {on:false});
  });
  const fHard = calcFactor(Object.assign({}, st, {walk:30, cycle:40, ex:exAll})).factor;
  const fRest = calcFactor(Object.assign({}, st, {walk:0,  cycle:0,  ex:exNone})).factor;
  if(fHard !== fRest || fHard !== st.baseFactor)
    fail(`目標の係数が運動量で動いています（ハード ${fHard} / 休養 ${fRest} / 基本 ${st.baseFactor}）`);

  // 4. 1日の上限
  /* 卵は「手で入れる個数」を切り詰める仕組み。メニューに含まれる卵は減らせないので
     （まぜのっけ＋親子丼＋ロースかつ重を選べば、それだけで3個になる）、
     見るのは入力欄が残り枠まで切り詰められているかどうか。 */
  const eggF = foodById('egg');
  const eggRoom = Math.max(0, eggF.max - menuEggs(st));
  if(st.foods.egg > eggRoom + 1e-9)
    fail(`卵の入力が残り枠を超えています：入力 ${st.foods.egg} > 残り ${eggRoom}` +
         `（上限 ${eggF.max} − メニューの卵 ${menuEggs(st)}）`);
  const maxSpoons = (st.twoDoses ? 2 : SESSIONS_OFF) * MAX_PER_SERVE;
  if(sv.spoons > maxSpoons)
    fail(`プロテインの杯数が上限超過：${sv.spoons} > ${maxSpoons}`);
  sv.sessions.forEach((sn, i) => { if(sn.spoons > MAX_PER_SERVE)
    fail(`プロテイン ${i + 1}回目が1回の上限超過：${sn.spoons} > ${MAX_PER_SERVE}`); });
  const riceF = foodById('rice');
  const riceCap = Math.min(riceF.autoMax, riceF.slotLimit * homeMealsOf(st).length);
  if(!autoOff('rice') && st.foods.rice > riceCap + 1e-9)
    fail(`ご飯が上限超過：${st.foods.rice}杯 > ${riceCap}杯（自宅の食事 ${homeMealsOf(st).length}食）`);
  const oliveF = foodById('olive');
  if(!autoOff('olive') && st.foods.olive > oliveF.autoMax + 1e-9)
    fail(`オリーブオイルが上限超過：${st.foods.olive}さじ > ${oliveF.autoMax}さじ`);
  FOODS.filter(f => f.autoFill).forEach(f => {
    if(!autoOff(f.id) && st.foods[f.id] > f.fillMax + 1e-9)
      fail(`${f.short} が上限超過：${st.foods[f.id]} > ${f.fillMax}`);
  });

  /* 5. 自動計算の線。品目によって線が違う。
        ・候補（ヨーグルト等）と油 … 食塩7.5g・飽和脂肪酸15g（毎日クリアしたい線）
        ・ご飯 … 飽和は上限の17gまで許す（1杯0.1gで、エネルギーの唯一の調整手段のため）
        ・どの品目でも上限17gは絶対に越えない
        自動計算ぶんを0にした状態（＝手入力と固定メニューだけ）が線の内側だった日だけを見る。 */
  const zero = {};
  FOODS.filter(isAuto).forEach(f => zero[f.id] = 0);
  const base   = withFoods(st, zero);
  const svBase = savasOf(base, calcFactor(base));
  const saltB  = calcSalt(base, svBase).total, satB = calcSat(base, svBase).total;
  const salt   = calcSalt(st, sv).total,       sat  = calcSat(st, sv).total;
  // どの自動品目が押し上げたのかを添える（プロテインの杯数が動いた分は自動計算のせいではない）
  const blame = key => FOODS.filter(isAuto).filter(f => st.foods[f.id] > 0 && f[key])
    .map(f => `${f.short} ${r1(st.foods[f.id])}${f.unit}＝${r1(st.foods[f.id] * f[key])}g`).join('・');
  const spoonNote = svBase.spoons === sv.spoons ? ''
    : `／プロテインも ${svBase.spoons}杯→${sv.spoons}杯 に動いています`;
  if(saltB <= SALT_LIMIT && salt > SALT_LIMIT + 0.05)
    fail(`自動計算で食塩が線を越えました：${saltB}g → ${salt}g（線 ${SALT_LIMIT}g／` +
         `${blame('salt')}${spoonNote}）`);
  /* 候補と油は15gの線の内側であること。
     ご飯を0にした状態を作り直して測ってはいけない（たんぱく質が変わってプロテインの杯数が動き、
     アプリが実際には作らない状態になる）。実際の最終状態から、ご飯のぶんの
     飽和脂肪酸（1杯0.1g）だけを引いて見る。 */
  const satRice = r1(FOODS.filter(f => f.autoRice || f.autoEnergy)
    .reduce((a, f) => a + (st.foods[f.id] || 0) * (f.sat || 0), 0));
  const satNoRice = r1(sat - satRice);
  if(satB <= SAT_GOOD && satNoRice > SAT_GOOD + 0.05)
    fail(`候補・油で飽和脂肪酸が${SAT_GOOD}gの線を越えました：${satB}g → ${satNoRice}g` +
         `（ご飯ぶん ${satRice}g を除いた値／${blame('sat')}${spoonNote}）`);
  // ご飯を含めても、上限の17gは自動計算では絶対に越えない
  if(satB <= SAT_LIMIT && sat > SAT_LIMIT + 0.05)
    fail(`自動計算で飽和脂肪酸が上限を越えました：${satB}g → ${sat}g（上限 ${SAT_LIMIT}g／` +
         `${blame('sat')}${spoonNote}）`);

  // 5b. ①の補正が必要エネルギーにそのまま乗っていること
  const needNoAdj = calcNeedBase(st, ex);
  if(calcNeed(st, ex) !== needNoAdj + c.kcalAdj)
    fail(`必要エネルギーの補正が合いません：推定 ${needNoAdj} ＋ 補正 ${c.kcalAdj} ` +
         `≠ ${calcNeed(st, ex)}`);

  /* 5c. プロテインの杯数も飽和脂肪酸15gの線で止まること（v.134のガード）。
        食品だけで線の内側だった日は、粉を足しても線を越えない。
        例外は「筋トレ日の最低杯数」と「杯数の手動指定」で、そこは下限・指定が優先。 */
  const satFoodOnly = calcSat(st, null).total;
  const trained = ex.done > 0 || ex.cardio > 0;
  const floorSpoons = trained ? MIN_SPOONS_TRAINED : 0;
  if(!c.fix && satFoodOnly <= SAT_GOOD && sv.spoons > floorSpoons && sat > SAT_GOOD + 0.05)
    fail(`プロテインで飽和脂肪酸が${SAT_GOOD}gの線を越えました：食品だけ ${satFoodOnly}g → ` +
         `${sat}g（${PROTEIN.name} ${sv.spoons}杯・下限 ${floorSpoons}杯）`);

  // 6. 総負荷量はチェックの入っている種目だけ
  let vol = 0;
  EXERCISES.forEach(e => {
    if($$('c_' + e.id).checked) vol += num('w_' + e.id) * num('r_' + e.id) * num('s_' + e.id);
  });
  if(Math.abs(vol - ex.volume) > 1e-6)
    fail(`総負荷量：チェックぶんの合計 ${vol} / calcFactor ${ex.volume}`);

  /* 7. ④の「運動が未入力」表示は、未入力のときだけ。
     丸数字はセクションの並びで変わる（v.147で運動が③→②）ので、番号は当てにしない。 */
  const warned = /運動は今日の分が未入力です/.test($$('oSatBox').innerHTML);
  if(warned !== !exEntered())
    fail(`④の未入力表示が実態と違います（表示 ${warned} / 未入力 ${!exEntered()}）`);

  // 8/9. ⑤の時刻
  const rows = [...$$('schedule').querySelectorAll('tr')];
  if(rows.length){
    const head0 = rows[0].querySelector('td.time').textContent;
    /* 運動もしておらず「休養日も摂る」もオフの日は、粉を1杯も摂らないので
       プロテインの行そのものが出ない（v.151）。そういう日は1行目が朝食になる。 */
    const ex0      = calcFactor(readState());
    const noPowder = !(ex0.done > 0 || ex0.cardio > 0) && !$$('restSavas').checked;
    const isPowder = head0.indexOf(PROTEIN.name) >= 0 || head0.indexOf('起床後') >= 0;
    if(!isPowder && !noPowder)
      fail(`⑤の1行目がプロテインの行ではありません：${head0.trim().slice(0, 20)}`);
    if(isPowder && TIME_RE.test(head0))
      fail(`⑤のプロテイン1回目に時刻が出ています：${head0.trim().slice(0, 20)}`);
    let prev = -Infinity, prevTxt = '';
    rows.forEach(tr => {
      const txt = tr.querySelector('td.time').textContent;
      const t = minutesOf(txt);
      if(t === null) return;
      if(t < prev) fail(`⑤の時刻が昇順ではありません：${prevTxt} → ${txt.trim().slice(0, 20)}`);
      prev = t; prevTxt = txt.trim().slice(0, 20);
    });
  }

  /* 13. ④の「残りを補う提案」も線を越えないこと（v.168のガード）。
         `energyAdvice` には以前から `capOfFood` があったのに、**ここだけ素通り**で、
         実測でサバ缶（みそ煮）2缶を提案し、その日の飽和が23.1g（上限17g）になっていた。
         契約は「提案前が線の内側なら、提案後も内側」「提案前が外なら1gも足さない」。 */
  const target  = r1(st.weight * ex.factor);
  const foodNow = calcFood(st);
  const toFoodG = r1(Math.max(0, target - r1(foodNow.total + sv.totalG)));
  const satNow  = calcSat(st, sv).total;
  const saltNow = calcSalt(st, sv).total;
  const plan    = toFoodG >= DEVIATION_OK ? suggestPlan(toFoodG, st, satNow, saltNow) : [];
  const addOf   = key => r1(plan.reduce((a, id) => {
    const f = foodById(id); return a + ((f && f[key]) || 0);
  }, 0));
  const satAdd = addOf('sat'), saltAdd = addOf('salt');
  const planLabel = () => formatPlan(plan);
  if(satNow <= SAT_GOOD && r1(satNow + satAdd) > SAT_GOOD + 0.05)
    fail(`④の提案で飽和脂肪酸が${SAT_GOOD}gの線を越えました：${satNow}g → ` +
         `${r1(satNow + satAdd)}g（提案 ${planLabel()}）`);
  if(satNow > SAT_GOOD && satAdd > 0.05)
    fail(`すでに飽和脂肪酸が線の外（${satNow}g）なのに、④が +${satAdd}g の提案をしています` +
         `（${planLabel()}）`);
  if(saltNow < SALT_LIMIT && r1(saltNow + saltAdd) >= SALT_LIMIT)
    fail(`④の提案で食塩が${SALT_LIMIT}gの線に達しました：${saltNow}g → ` +
         `${r1(saltNow + saltAdd)}g（提案 ${planLabel()}）`);
  if(saltNow >= SALT_LIMIT && saltAdd > 0.05)
    fail(`すでに食塩が線の外（${saltNow}g）なのに、④が +${saltAdd}g の提案をしています` +
         `（${planLabel()}）`);

  /* 14. ⑤が中身を隠していないこと。
         ③に数量が入っている品目と、④が提案した品目は、⑤のどこかに名前が出ているはず。
         v.166まで、**くわしい説明がオフだと④の提案が⑤から消えていた**
         （利用者が「こんな献立あり得ますか」と報告するまで分からなかった）。 */
  const schedTxt = $$('schedule').textContent;
  FOODS.forEach(f => {
    if(!((st.foods[f.id] || 0) > 0)) return;
    const nm = f.short || f.name;
    if(schedTxt.indexOf(nm) < 0)
      fail(`⑤に「${nm}」が出ていません（③の数量 ${r1(st.foods[f.id])}${f.unit}）`);
  });
  [...new Set(plan)].forEach(id => {
    const f = foodById(id); if(!f) return;
    const nm = f.short || f.name;
    if(schedTxt.indexOf(nm) < 0)
      fail(`⑤に④の提案「${nm}」が出ていません（提案 ${planLabel()}）`);
  });

  /* 15. エネルギーが必要量を大きく下回る日は、④がそう出していること。
         ⑤だけを見て食べると気づけないので、④の札は必ず立てる。 */
  const kcalTotal = calcKcal(st, sv).total;
  const needNow   = calcNeed(st, ex);
  const kcalRow   = [...$$('oSatBox').querySelectorAll('tr')]
    .find(tr => tr.querySelector('th') && tr.querySelector('th').textContent.trim() === 'エネルギー');
  if(kcalRow && kcalTotal - needNow <= -ENERGY_BAD && kcalRow.className !== 'under')
    fail(`エネルギーが必要量を ${Math.round(needNow - kcalTotal)}kcal 下回るのに、` +
         `④の札が「足りない」になっていません（class=${kcalRow.className}）`);

  // 10. 再計算の冪等性
  const a = snapshot();
  render();
  const b = snapshot();
  if(a !== b) fail('再計算で結果が変わりました（冪等ではありません）');
}

/* ---------- 実行 ---------- */
/* 失敗のまとめ方は run と runAsync で同じにする */
function report(n, seed, fails, sec){
  console.log(`\n${n}ケース / 種 ${seed} / ${sec}秒`);
  if(!fails.length){
    console.log('%c✅ すべて通りました', 'color:#0a0;font-weight:bold');
  }else{
    console.log(`%c✕ ${fails.length}件`, 'color:#c00;font-weight:bold');
    // 同じ内容の失敗はまとめて、代表の再現手順を出す
    const byMsg = new Map();
    fails.forEach(f => {
      const key = f.msg.replace(/[0-9.]+/g, '#');
      if(!byMsg.has(key)) byMsg.set(key, {count: 0, first: f});
      byMsg.get(key).count++;
    });
    [...byMsg.values()].sort((x, y) => y.count - x.count).forEach(({count, first}) => {
      console.log(`  ${count}件  ${first.msg}`);
      console.log(`        再現: PSCheck.only(${seed}, ${first.n})`, first.c);
    });
  }
  console.log('終わったら PSCheck.restore() を実行して、ページを再読み込みしてください。');
}

const PSCheck = {
  run(n, seed){
    n = n || 1000;
    seed = seed === undefined ? (Math.random() * 1e9) | 0 : seed;
    const rnd = mulberry32(seed);
    const fails = [];
    const t0 = RealDate.now();
    for(let i = 0; i < n; i++){
      const c = makeCase(rnd, i);
      const push = msg => fails.push({n: i, msg, c});
      try {
        applyCase(c);
        checkOne(c, push);
      } catch(err){
        push('例外: ' + (err && err.message ? err.message : String(err)));
        console.error(err);
      } finally {
        try { cleanupCase(c); } catch(e){}
      }
      if((i + 1) % 100 === 0) console.log(`  ${i + 1}/${n} … 失敗 ${fails.length}件`);
    }
    const sec = ((RealDate.now() - t0) / 1000).toFixed(1);
    report(n, seed, fails, sec);
    return {seed, n, fails, sec};
  },

  /* 同じ検証を**画面を止めずに**回す。
     1ケース約1.3秒かかるので、1,000ケースを同期で回すとタブが20分以上固まる。
     `PSCheck.progress` で途中経過を見られる。 */
  runAsync(n, seed, chunk){
    n = n || 1000;
    chunk = chunk || 5;
    seed = seed === undefined ? (Math.random() * 1e9) | 0 : seed;
    const rnd = mulberry32(seed);
    const fails = [];
    const t0 = RealDate.now();
    let i = 0;
    PSCheck.progress = {done: 0, n, seed, fails, running: true, sec: null};
    return new Promise(resolve => {
      const step = () => {
        const end = Math.min(i + chunk, n);
        for(; i < end; i++){
          const c = makeCase(rnd, i);
          const push = msg => fails.push({n: i, msg, c});
          try { applyCase(c); checkOne(c, push); }
          catch(err){ push('例外: ' + (err && err.message ? err.message : String(err))); }
          finally { try { cleanupCase(c); } catch(e){} }
        }
        PSCheck.progress.done = i;
        if(i < n){ setTimeout(step, 0); return; }
        const sec = ((RealDate.now() - t0) / 1000).toFixed(1);
        PSCheck.progress.running = false;
        PSCheck.progress.sec = sec;
        report(n, seed, fails, sec);
        resolve({seed, n, fails, sec});
      };
      setTimeout(step, 0);
    });
  },

  // 失敗したケースだけを流して、そのまま画面に残す（目で確かめるため）
  only(seed, n){
    const rnd = mulberry32(seed);
    let c;
    for(let i = 0; i <= n; i++) c = makeCase(rnd, i);
    applyCase(c);
    updateLive();
    render();
    console.log('このケースを画面に出しました（Dateはこの曜日に固定したままです）', c);
    return c;
  },

  restore(){
    window.Date = RealDate;
    try {
      if(SAVED === null) localStorage.removeItem('savas-calc-v3');
      else localStorage.setItem('savas-calc-v3', SAVED);
    } catch(e){}
    console.log('Date と localStorage を戻しました。ページを再読み込みしてください。');
  }
};

window.PSCheck = PSCheck;
console.log('PSCheck を読み込みました。PSCheck.run(1000) で開始、終わったら PSCheck.restore()。');
})();

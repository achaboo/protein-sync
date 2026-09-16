/* README.md ↔ index.html の機械照合。
     node tools/crosscheck.js       食い違いだけを出す
     node tools/crosscheck.js -v    照合できた表の一覧も出す
   食い違いがあれば終了コード 1、無ければ 0。
   README か index.html を直したら必ず通すこと（CLAUDE.md「作業の進め方」）。

   照合しているもの：
     ・食品マスタ表 ↔ FOODS の全項目（SAVASの行は *_PER_SPOON 定数と突合）
     ・「調整できる定数」の表 ↔ コードの実値／表に載っていない定数の洗い出し
     ・1週間の型の表 ↔ WEEKLY_PLAN（サバ缶の缶数・ドレッシングの日数・外食の曜日）
     ・筋トレ種目と初期値 / WEEK_EX
     ・廃止した機能の名前が復活していないか（プリセット v.122 / 体重の推移で補正 v.124）
     ・たんぱく質10gあたりの飽和脂肪酸を sat ÷ p × 10 で再計算（並びが昇順かも見る）
     ・丼の比較表・自動候補の表・基本係数表・SAVAS上限%の表の数値を再計算
     ・マークダウン表の列数、** と括弧の対応、キリル文字の混入
     ・README の引用（> の行）が実際の画面の文言と一致しているか
     ・CLAUDE.md の v.NNN と APP_VERSION、README の DEFAULTS_VER 記述と RESET_IDS

   このファイルは開発用で、index.html はこれに一切依存しない。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');   // スクリプト自身の位置から解決する

const html   = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const js     = html.match(/<script>([\s\S]*)<\/script>/)[1];

const issues = [];
const bad = (cat, msg) => issues.push(`[${cat}] ${msg}`);
const r1 = n => Math.round(n * 10) / 10;

/* ---------- コード側の値を取り出す ---------- */
const block = (name, open, close) => {
  const i = js.indexOf(`const ${name} = ${open}`);
  if(i < 0) throw new Error(`${name} が見つかりません`);
  const j = js.indexOf(`\n${close};`, i);
  if(j < 0) throw new Error(`${name} の終端が見つかりません`);
  return js.slice(i + `const ${name} = `.length, j + 1 + close.length);
};
const evalBlock = (name, open, close) => eval('(' + block(name, open, close) + ')');

const FOODS          = evalBlock('FOODS', '[', ']');
const EXERCISES      = evalBlock('EXERCISES', '[', ']');
const WEEK_EX        = evalBlock('WEEK_EX', '[', ']');
const SAT_RATIO      = evalBlock('SAT_RATIO', '[', ']');
const WEEKLY_PLAN    = evalBlock('WEEKLY_PLAN', '{', '}');

/* 定数の値を取り出す。`const A = 1, B = 2;` のように1行に複数あるので、
   , か ; か 改行 か行コメントまでを値とみなす。 */
const rawConst = name => {
  const m = js.match(new RegExp(`(?:const|,)\\s*${name}\\s*=\\s*([^;,\\n]+)`));
  return m ? m[1].replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*$/, '').trim() : null;
};
/* 他の定数から作っている値（TWO_MEAL_SPOONS = MAX_PER_SERVE * 2 など）も
   評価できるよう、土台になる定数を先に宣言してから eval する。 */
const BASE_CONSTS = ['SPOON_G', 'PER_SERVE', 'MAX_PER_SERVE', 'SESSIONS_OFF'];
const evalWith = expr => eval(
  BASE_CONSTS.map(n => `const ${n} = ${rawConst(n)};`).join('') + '(' + expr + ')');
const scalar = name => {
  const raw = rawConst(name);
  if(raw === null){ bad('定数', `${name} がコードに見つかりません`); return undefined; }
  try { return evalWith(raw); } catch(e){ return raw; }
};
const SPOON_G = scalar('SPOON_G');
const byId = id => FOODS.find(f => f.id === id);

/* ---------- README のマークダウン表を拾う ---------- */
const lines = readme.split('\n');
// 見出しの行番号 → セクション名
const sectionAt = n => {
  for(let i = n; i >= 0; i--) if(/^#{2,4} /.test(lines[i])) return lines[i].replace(/^#+ /, '');
  return '(先頭)';
};
const tables = [];
for(let i = 0; i < lines.length; i++){
  if(!/^\|/.test(lines[i])) continue;
  if(!/^\|[\s:|-]+\|\s*$/.test(lines[i + 1] || '')) continue;
  const head = lines[i].split('|').slice(1, -1).map(s => s.trim());
  const rows = [];
  let j = i + 2;
  for(; j < lines.length && /^\|/.test(lines[j]); j++){
    rows.push({cells: lines[j].split('|').slice(1, -1).map(s => s.trim()), line: j + 1});
  }
  tables.push({head, rows, line: i + 1, sep: lines[i + 1], section: sectionAt(i)});
  i = j - 1;
}
// どの表を実際に照合できたかを最後に出す（見つからず黙って素通りするのを防ぐ）
const coverage = [];
const findTable = (...cols) => {
  const t = tables.find(x => cols.every(c => x.head.includes(c)));
  coverage.push({cols: cols.join('/'), found: !!t, line: t ? t.line : null,
                 rows: t ? t.rows.length : 0});
  return t;
};
// 定数表で、その定数の行の n 列目を取る
const cellsOf = (t, name, n) => {
  const r = t.rows.find(x => x.cells[0].replace(/[`*]/g, '').trim() === name);
  return r ? r.cells[n] : '';
};

/* 入力欄の初期値を index.html から読む。
   README に書いてある「73.5kgでの目標」のような値をここで決め打ちにすると、
   体重の初期値を変えたときに照合側だけ取り残される。 */
const htmlDefault = id => {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))
         || html.match(new RegExp(`value="([^"]*)"[^>]*id="${id}"`));
  return m ? parseFloat(m[1]) : NaN;
};

const plain = s => s.replace(/\*\*/g, '').replace(/<br>/g, ' ').replace(/`/g, '').trim();
const numOf = s => {
  const t = plain(s);
  if(/^(—|-|無料)$/.test(t)) return 0;
  const m = t.replace(/,/g, '').match(/-?[0-9]+(\.[0-9]+)?/);
  return m ? parseFloat(m[0]) : NaN;
};
const eq = (a, b) => Math.abs(a - b) < 1e-6;

/* ============================================================
   1. 食品マスタ表 ↔ FOODS
   ============================================================ */
(() => {
  const t = findTable('店', '食品', 'たんぱく質', '脂質', '飽和', '食塩', '炭水化物', '食物繊維', 'kcal', '価格', '単位');
  if(!t){ bad('食品表', '食品マスタの表が README に見つかりません'); return; }
  const seen = new Set();
  const SKIP = ['SAVAS（1杯）', 'その他（自由入力）'];
  t.rows.forEach(({cells, line}) => {
    const [shop, name, p, fat, sat, salt, carbG, fiber, kcal, price, unit] = cells.map(plain);
    if(SKIP.includes(name)) return;
    const f = FOODS.find(x => x.name === name && (x.shop || '—') === (shop || '—'));
    if(!f){ bad('食品表', `README:${line} 「${shop} ${name}」が FOODS にありません`); return; }
    seen.add(f.id);
    const chk = (label, want, got) => {
      if(!eq(numOf(want), got || 0))
        bad('食品表', `README:${line} ${f.id} の${label}：README ${plain(want)} / コード ${got}`);
    };
    chk('たんぱく質', p, f.p);
    chk('脂質', fat, f.fat);
    chk('飽和脂肪酸', sat, f.sat);
    chk('食塩', salt, f.salt);
    chk('炭水化物', carbG, f.carbG);
    chk('食物繊維', fiber, f.fiber);
    chk('kcal', kcal, f.kcal);
    chk('価格', price, f.price);
    if(unit !== f.unit) bad('食品表', `README:${line} ${f.id} の単位：README ${unit} / コード ${f.unit}`);
    if(/無料/.test(price) && f.price !== 0)
      bad('食品表', `README:${line} ${f.id} は「無料」だがコードは ${f.price}円`);
  });
  FOODS.filter(f => !f.custom && !seen.has(f.id))
       .forEach(f => bad('食品表', `${f.id}（${f.shop || ''}${f.name}）が README の食品マスタ表にありません`));
  // SAVAS の行は定数と突き合わせる
  const sv = t.rows.find(r => plain(r.cells[1]) === 'SAVAS（1杯）');
  if(sv){
    const c = sv.cells.map(plain);
    const want = {2:SPOON_G, 3:scalar('FAT_PER_SPOON'), 4:scalar('SAT_PER_SPOON'),
                  5:scalar('SALT_PER_SPOON'), 6:scalar('CARB_PER_SPOON'),
                  7:scalar('FIBER_PER_SPOON'), 8:scalar('KCAL_PER_SPOON')};
    Object.entries(want).forEach(([i, v]) => {
      if(!eq(numOf(c[i]), v))
        bad('食品表', `README:${sv.line} SAVAS(1杯) の${t.head[i]}：README ${c[i]} / コード ${v}`);
    });
  }
})();

/* ============================================================
   2. 定数表 ↔ コードの実値
   ============================================================ */
(() => {
  const t = findTable('定数', '初期値', '意味');
  if(!t){ bad('定数表', '定数表が README に見つかりません'); return; }
  // コードの定数ではなく別の場所で定義しているもの
  const SPECIAL = {
    // 「品目ごと」の行。数値は同じ行の「意味」の欄に書いてあるので、そちらと突き合わせる
    // 意味欄は「ヨーグルト4・納豆3・ツナ2・チキン2」のように名前を略しているので、
    // 数の並びが FOODS の fillMax と一致するかで見る
    fillMax: () => {
      const num = s => (s.match(/[0-9]+/g) || []).map(Number).sort((a, b) => a - b).join(',');
      const want = num(FOODS.filter(f => f.autoFill).map(f => f.fillMax).join(' '));
      // 「1日の上限」の "1日" は数に数えない
      const got  = num(plain(cellsOf(t, 'fillMax', 2)).replace(/1日/g, ''));
      if(want !== got)
        bad('定数表', `fillMax：README ${got.join('・')} / コード ` +
          FOODS.filter(f => f.autoFill).map(f => `${f.short}${f.fillMax}`).join('・'));
      return null;
    },
    autoMax: () => {
      FOODS.filter(f => f.autoMax).forEach(f => {
        if(!plain(cellsOf(t, 'autoMax', 2)).includes(`${f.short}${f.autoMax}`))
          bad('定数表', `autoMax：${f.short} は ${f.autoMax} だが README の意味欄と合いません`);
      });
      return null;
    },
    FOODS:     () => null, SAT_RATIO: () => null, EXERCISES: () => null, exDate: () => null,
    WATER:     () => null,
    'TREND_MIN_DAYS / TREND_MAX_DAYS': () => [scalar('TREND_MIN_DAYS'), scalar('TREND_MAX_DAYS')],
    'FAT_MIN_E / FAT_MAX_E': () => [scalar('FAT_MIN_E'), scalar('FAT_MAX_E')],
    'CARB_MIN_E / CARB_MAX_E': () => [scalar('CARB_MIN_E'), scalar('CARB_MAX_E')],
    'KCAL_PER_FAT / KCAL_PER_CARB': () => [scalar('KCAL_PER_FAT'), scalar('KCAL_PER_CARB')],
    'WALK_KCAL / CYCLE_KCAL': () => [scalar('WALK_KCAL'), scalar('CYCLE_KCAL')],
    'WATER / WATER_ML': () => null,
    TREND_GOAL: () => null,
    WEEK_EX: () => WEEK_EX.length
  };
  t.rows.forEach(({cells, line}) => {
    const name = plain(cells[0]);
    const want = plain(cells[1]);
    if(SPECIAL[name]){
      const v = SPECIAL[name]();
      if(v === null) return;                       // 表現が自由な行は照合しない
      if(Array.isArray(v)){
        const nums = want.replace(/,/g, '').match(/-?[0-9]+(\.[0-9]+)?/g) || [];
        v.forEach((x, i) => { if(!eq(parseFloat(nums[i]), x))
          bad('定数表', `README:${line} ${name}：README ${want} / コード ${v.join(' / ')}`); });
        return;
      }
      if(typeof v === 'number' && !eq(numOf(want), v))
        bad('定数表', `README:${line} ${name}：README ${want} / コード ${v}`);
      if(typeof v === 'string' && !want.includes(String(FOODS.find(f=>f.autoFill).fillMax)))
        bad('定数表', `README:${line} ${name}：README ${want} / コード ${v}`);
      return;
    }
    if(/^[A-Z_]+$/.test(name.split(' ')[0]) === false) return;
    const raw = rawConst(name);
    if(raw === null){ bad('定数表', `README:${line} ${name} がコードに見つかりません`); return; }
    let v;
    // TWO_MEAL_SPOONS のように他の定数から作る値も評価できるようにする
    try { v = evalWith(raw); } catch(e){ return; }
    if(Array.isArray(v)){
      const nums = want.replace(/[[\],]/g, ' ').match(/-?[0-9]+(\.[0-9]+)?/g) || [];
      if(nums.length !== v.length || v.some((x, i) => !eq(parseFloat(nums[i]), x)))
        bad('定数表', `README:${line} ${name}：README ${want} / コード [${v}]`);
      return;
    }
    if(typeof v === 'number' && !eq(numOf(want), v))
      bad('定数表', `README:${line} ${name}：README ${want} / コード ${v}`);
  });
  // コードにあるのに定数表に無い主な定数
  const listed = new Set(t.rows.flatMap(r => plain(r.cells[0]).split(/\s*\/\s*/)));
  ['SPOON_G','PER_SERVE','MAX_PER_SERVE','SESSIONS_OFF','MIN_SPOONS_TRAINED','WATER_ML','TOLERANCE',
   'MIN_PER_SERVE','MILK_SLACK','MEAL_P_OPT','MEAL_P_LO','MEAL_P_MUCH','FILL_STEPS','FILL_KCAL_REF','RICE_P_WEIGHT',
   'STRENGTH_FULL','CARDIO_FULL','SAT_LIMIT','SAT_PER_SPOON','SALT_LIMIT','SALT_PER_SPOON',
   'CARB_PER_SPOON','FIBER_PER_SPOON','KCAL_PER_SPOON','FIBER_TARGET','FAT_PER_SPOON','ACTIVITY',
   'KCAL_PER_VOLUME','WALK_KCAL','CYCLE_KCAL','TREND_KCAL_PER_KG','TREND_MIN_DAYS','TREND_MAX_DAYS',
   'TREND_CAP','ENERGY_MIN_NET','ENERGY_OVER_OK','ENERGY_OK','ENERGY_CARE','ENERGY_BAD','SALT_CARE',
   'SALT_BAD','SAT_GOOD','SAT_PER_UNIT_MIN','SALT_PER_UNIT_MIN','HOME_B_QUOTA','WEEK_P_RATIO',
   'WEEK_COST_AIM','WEEK_EX_DAY','DEVIATION_OK','FLOOR_FACTOR','CARB_SHARE','RICE_BOWL_CARB',
   'CARB_MIN_E','CARB_MAX_E','KCAL_PER_FAT','KCAL_PER_CARB','TWO_MEAL_SPOONS','ALT_MIN_P']
    .forEach(n => {
      if(listed.has(n) || !new RegExp(`(?:const|,)\\s*${n}\\s*=`).test(js)) return;
      // 名前が README のどこにも出てこないものと、本文には書いてあるものを分ける
      bad(readme.includes(n) ? '定数表(参考)' : '定数表(欠落)',
          `${n}（＝${rawConst(n)}）は README の定数表にありません` +
          (readme.includes(n) ? '（本文には名前が出ています）' : '（名前が README のどこにもありません）'));
    });
})();

/* ============================================================
   3. 1週間の型の表 ↔ WEEKLY_PLAN
   ============================================================ */
(() => {
  const t = findTable('曜日', '朝食', '夕食', '自動で決まるもの');
  if(!t){ bad('週の型', '1週間の型の表が README に見つかりません'); return; }
  const LABEL = ['日','月','火','水','木','金','土'];
  const rowFor = {};
  t.rows.forEach(({cells, line}) => {
    plain(cells[0]).split('・').forEach(d => rowFor[d] = {cells, line});
  });
  LABEL.forEach((lab, idx) => {
    const r = rowFor[lab];
    if(!r){ bad('週の型', `曜日「${lab}」の行が README の表にありません`); return; }
    const plan = WEEKLY_PLAN[idx] || {};
    const bText = plain(r.cells[1]), dText = plain(r.cells[2]);
    const wantB = Object.keys(plan).filter(id => (byId(id) || {}).slot === 'b');
    const wantD = Object.keys(plan).filter(id => (byId(id) || {}).slot === 'd');
    wantB.forEach(id => { if(!bText.includes(byId(id).name.replace(/（.*/, '')))
      bad('週の型', `README:${r.line} ${lab}曜の朝食に ${byId(id).name} が書かれていません`); });
    wantD.forEach(id => { if(!dText.includes(byId(id).name.replace(/（.*/, '')) && !/自宅/.test(dText))
      bad('週の型', `README:${r.line} ${lab}曜の夕食に ${byId(id).name} が書かれていません`); });
  });
  // サバ缶の缶数・ドレッシングの有無
  const sabaDays = Object.values(WEEKLY_PLAN).filter(p => p.saba).length;
  if(!readme.includes(`週${sabaDays}缶`))
    bad('週の型', `サバ缶は週${sabaDays}缶だが README に「週${sabaDays}缶」の記述がありません`);
  const dressDays = Object.values(WEEKLY_PLAN).filter(p => p.dressing).length;
  if(dressDays !== 6) bad('週の型', `ドレッシングの日数が ${dressDays} 日です（README は木曜以外＝6日）`);
  // 外食の日
  const eatOut = Object.keys(WEEKLY_PLAN).filter(i =>
    Object.keys(WEEKLY_PLAN[i]).some(id => (byId(id) || {}).shop && byId(id).slot === 'd'));
  if(eatOut.length !== 1 || eatOut[0] !== '4')
    bad('週の型', `外食の夕食がある曜日：${eatOut.map(i => LABEL[i]).join('・')}（README は木曜だけ）`);
})();

/* ============================================================
   4. 筋トレ種目 / プリセット / 有酸素 / 運動の前提
   ============================================================ */
(() => {
  const t = findTable('種目', '部位', '初期値');
  if(!t){ bad('筋トレ表', '筋トレ種目の表が README に見つかりません'); return; }
  if(t.rows.length !== EXERCISES.length)
    bad('筋トレ表', `種目数：README ${t.rows.length} / コード ${EXERCISES.length}`);
  t.rows.forEach(({cells, line}) => {
    const name = plain(cells[0]);
    const e = EXERCISES.find(x => x.name === name);
    if(!e){ bad('筋トレ表', `README:${line} 種目「${name}」がコードにありません`); return; }
    if(plain(cells[1]) !== e.part)
      bad('筋トレ表', `README:${line} ${name} の部位：README ${plain(cells[1])} / コード ${e.part}`);
    const nums = plain(cells[2]).replace(/,/g, '').match(/[0-9]+(\.[0-9]+)?/g) || [];
    const wantNums = [e.w, e.r, e.s];
    wantNums.forEach((v, i) => { if(!eq(parseFloat(nums[i]), v))
      bad('筋トレ表', `README:${line} ${name} の初期値：README ${plain(cells[2])} / コード ${e.w}kg/${e.r}回/${e.s}セット`); });
  });
  // 総負荷量の記述
  const vol = EXERCISES.reduce((a, e) => a + e.w * e.r * e.s, 0);
  if(!readme.includes(vol.toLocaleString()))
    bad('筋トレ表', `8種目の総負荷量 ${vol.toLocaleString()} kg が README に出てきません`);

  /* 筋トレ・有酸素のプリセットは v.122 で廃止した（毎日手で入れるため）。
     ボタンが復活していないかだけ見ておく。 */
  ['EX_PRESETS', 'CARDIO_PRESETS', 'cardioPreset', 'exPreset', 'exConfirm', 'exRest',
   'TREND_KCAL_PER_KG', 'TREND_GOAL', 'TREND_CAP', 'needTrend', 'trendDays', 'trendCalc']
    .forEach(name => { if(js.includes(name))
      bad('廃止済み', `${name} が index.html に残っています（v.122で削除したはず）`); });
  ['ボタン'].forEach(col => {
    const t2 = tables.find(x => x.head.includes(col) && x.section.indexOf('運動') < 0);
    if(t2 && /プリセット|全種目|ウォーキング10km/.test(t2.rows.map(r => r.cells.join()).join()))
      bad('廃止済み', `README:${t2.line} プリセットの表が残っています（${t2.section}）`);
  });

  // 運動の前提
  const tw = findTable('前提', '内容');
  if(!tw){ bad('運動の前提', '「運動の前提」の表が見つかりません'); }
  else {
    if(tw.rows.length !== WEEK_EX.length)
      bad('運動の前提', `前提の数：README ${tw.rows.length} / コード ${WEEK_EX.length}`);
    tw.rows.forEach(({cells, line}) => {
      const label = plain(cells[0]);
      if(!WEEK_EX.some(x => x.label === label))
        bad('運動の前提', `README:${line} 「${label}」がコードの WEEK_EX にありません`);
    });
    WEEK_EX.forEach(x => {
      if(!tw.rows.some(r => plain(r.cells[0]) === x.label))
        bad('運動の前提', `WEEK_EX の「${x.label}」が README の表にありません`);
    });
  }
})();

/* ============================================================
   5. たんぱく質10gあたりの飽和脂肪酸（sat ÷ p × 10 を再計算）
   ============================================================ */
(() => {
  const t = findTable('食品', 'たんぱく質10gあたりの飽和脂肪酸');
  if(!t){ bad('飽和/P10g', 'たんぱく質10gあたりの飽和脂肪酸の表が見つかりません'); return; }
  let prev = -Infinity;
  t.rows.forEach(({cells, line}) => {
    const name = plain(cells[0]);
    const want = numOf(cells[1]);
    let got;
    if(name === 'SAVAS') got = r1(scalar('SAT_PER_SPOON') / SPOON_G * 10);
    else {
      const f = FOODS.find(x => ((x.shop ? x.shop + ' ' : '') + x.name) === name)
             || FOODS.find(x => x.name === name)
             || FOODS.find(x => ((x.shop ? x.shop + ' ' : '') + x.short) === name)
             || FOODS.find(x => x.short === name);
      if(!f){ bad('飽和/P10g', `README:${line} 「${name}」が FOODS にありません`); return; }
      got = r1(f.sat / f.p * 10);
    }
    if(!eq(want, got))
      bad('飽和/P10g', `README:${line} ${name}：README ${want}g / 再計算 ${got}g`);
    if(got < prev - 1e-9)
      bad('飽和/P10g', `README:${line} ${name}（${got}g）は昇順の並びから外れています`);
    prev = got;
  });
})();

/* ============================================================
   6. 牛丼・牛めし・豚丼の比較表
   ============================================================ */
(() => {
  const t = findTable('品目', 'たんぱく質', '飽和脂肪酸', 'たんぱく質10gあたりの飽和');
  if(!t) return;
  t.rows.forEach(({cells, line}) => {
    const name = plain(cells[0]);
    const f = FOODS.find(x => ((x.shop ? x.shop + ' ' : '') + x.short) === name)
           || FOODS.find(x => x.short === name);
    if(!f){ bad('比較表', `README:${line} 「${name}」が FOODS にありません`); return; }
    if(!eq(numOf(cells[1]), f.p))  bad('比較表', `README:${line} ${name} のP：README ${plain(cells[1])} / コード ${f.p}`);
    if(!eq(numOf(cells[2]), f.sat))bad('比較表', `README:${line} ${name} の飽和：README ${plain(cells[2])} / コード ${f.sat}`);
    if(!eq(numOf(cells[3]), r1(f.sat / f.p * 10)))
      bad('比較表', `README:${line} ${name} の10gあたり：README ${plain(cells[3])} / 再計算 ${r1(f.sat / f.p * 10)}`);
  });
})();

/* ============================================================
   7. 自動で埋める候補の表（p/salt/sat/kcal/price/上限）
   ============================================================ */
(() => {
  const t = findTable('候補', 'たんぱく質', '食塩', '飽和', 'kcal', '価格', '1日の上限');
  if(!t){ bad('候補表', '「たんぱく質の残りを埋める候補」の表が見つかりません'); return; }
  const auto = FOODS.filter(f => f.autoFill);
  if(t.rows.length !== auto.length)
    bad('候補表', `候補の数：README ${t.rows.length} / コード ${auto.length}`);
  t.rows.forEach(({cells, line}) => {
    const name = plain(cells[0]);
    const f = FOODS.find(x => x.name === name || x.short === name);
    if(!f){ bad('候補表', `README:${line} 「${name}」が FOODS にありません`); return; }
    if(!f.autoFill) bad('候補表', `README:${line} ${name} は autoFill ではありません`);
    const chk = (label, want, got) => { if(!eq(numOf(want), got || 0))
      bad('候補表', `README:${line} ${name} の${label}：README ${plain(want)} / コード ${got}`); };
    chk('たんぱく質', cells[1], f.p);
    chk('食塩', cells[2], f.salt);
    chk('飽和', cells[3], f.sat);
    chk('kcal', cells[4], f.kcal);
    chk('価格', cells[5], f.price);
    chk('1日の上限', cells[6], f.fillMax);
  });
})();

/* ============================================================
   8. 基本係数の表（初期値の体重での目標）
   ============================================================ */
(() => {
  const W = htmlDefault('weight');
  const t = findTable('基本係数', '想定', `${W}kgでの目標`);
  if(!t) return;
  t.rows.forEach(({cells, line}) => {
    const k = numOf(cells[0]), want = numOf(cells[2]);
    if(!eq(want, r1(W * k)))
      bad('係数表', `README:${line} 係数${k}：README ${plain(cells[2])} / 再計算 ${r1(W * k)}g`);
  });
})();

/* ============================================================
   9. SAVASで賄う上限の表（%→g）
   ============================================================ */
(() => {
  const t = findTable('上限%', '賄う量');
  if(!t) return;
  const target = r1(htmlDefault('weight') * htmlDefault('baseFactor'));
  t.rows.forEach(({cells, line}) => {
    const pct = numOf(cells[0]);
    const want = numOf(cells[1]);
    const got = r1(target * pct / 100);
    if(!eq(want, got))
      bad('SAVAS上限表', `README:${line} ${pct}%：README ${plain(cells[1])} / 再計算 ${got}g（目標${target}g）`);
  });
})();

/* ============================================================
   10. マークダウン表の形（列数・区切り行）
   ============================================================ */
tables.forEach(t => {
  if(t.sep.split('|').slice(1, -1).length !== t.head.length)
    bad('表の形', `README:${t.line} 区切り行の列数が見出しと違います（${t.section}）`);
  t.rows.forEach(({cells, line}) => {
    if(cells.length !== t.head.length)
      bad('表の形', `README:${line} 列数 ${cells.length}（見出しは ${t.head.length}）：${t.section}`);
  });
});

/* ============================================================
   11. ** の対応・括弧の対応・キリル文字
   ============================================================ */
[['README.md', readme], ['CLAUDE.md', claude]].forEach(([file, text]) => {
  text.split('\n').forEach((ln, i) => {
    const n = i + 1;
    // 表の行は、1行の中で ** を閉じていないとセルをまたいで崩れる
    if(/^\|/.test(ln) && (ln.match(/\*\*/g) || []).length % 2)
      bad('表記', `${file}:${n} 表の行で ** が閉じていません: ${ln.trim().slice(0, 70)}`);
    const cyr = ln.match(/[\u0400-\u04FF]/g);
    if(cyr) bad('表記', `${file}:${n} キリル文字 ${[...new Set(cyr)].join('')} が混入しています`);
  });
  // ** と括弧は段落単位で見る（強調も括弧も行をまたぐため）
  text.split(/\n\s*\n/).forEach((para, i) => {
    if((para.match(/\*\*/g) || []).length % 2)
      bad('表記', `${file} 第${i + 1}段落 ** の数が奇数です: ` +
        para.trim().split('\n')[0].slice(0, 60));
    const pairs = [['（', '）'], ['「', '」'], ['『', '』'], ['【', '】']];
    pairs.forEach(([o, c]) => {
      const a = (para.match(new RegExp(o, 'g')) || []).length;
      const b = (para.match(new RegExp(c, 'g')) || []).length;
      if(a !== b) bad('表記', `${file} 第${i + 1}段落 ${o}${c} の対応が ${a}/${b} で合いません: ` +
        para.trim().split('\n')[0].slice(0, 60));
    });
    const ao = (para.match(/\(/g) || []).length, ac = (para.match(/\)/g) || []).length;
    if(ao !== ac) bad('表記', `${file} 第${i + 1}段落 半角括弧の対応が ${ao}/${ac}: ` +
      para.trim().split('\n')[0].slice(0, 60));
  });
});

/* ============================================================
   12. バージョン表記
   ============================================================ */
(() => {
  const ver = js.match(/const APP_VERSION = '([^']+)'/)[1];   // 2026-09-01.120
  const n = ver.split('.').pop();
  const m = claude.match(/v\.(\d+)/);
  if(!m) bad('バージョン', 'CLAUDE.md に v.NNN の表記がありません');
  else if(m[1] !== n) bad('バージョン', `CLAUDE.md は v.${m[1]} / APP_VERSION は ${ver}`);
  const dv = js.match(/const DEFAULTS_VER = (\d+)/)[1];
  const rv = readme.match(/v(\d+)（「運動を終える時刻」/);
  if(rv && rv[1] !== dv) bad('バージョン', `README の DEFAULTS_VER 説明は v${rv[1]} / コードは ${dv}`);
  const ids = eval(js.match(/const RESET_IDS = \(\) => (\[[^\]]*\])/)[1]);
  ids.forEach(id => { if(!readme.includes(`'${id}'`))
    bad('バージョン', `RESET_IDS の ${id} が README に書かれていません`); });
})();

/* ============================================================
   13. README の引用（> の行）が、実際に画面へ出る文言と一致しているか
   ------------------------------------------------------------
   画面の文言を直したのに README の引用を直し忘れる、という抜けが
   実際に起きた（v.123 で⚠の文言を変えたとき）。テンプレートリテラルの
   ${...} と数字・時刻・タグを伏せ字にしてから突き合わせる。
   ============================================================ */
(() => {
  const MASK = '';
  const norm = t => t
    .replace(/\$\{[^}]*\}/g, MASK)          // 埋め込み式
    .replace(/<[^>]+>/g, '')                 // タグ
    .replace(/`\s*\+\s*`/g, '')             // 文字列連結の継ぎ目
    .replace(/\n/g, '')
    .replace(/[0-9,:]+/g, MASK)              // 数字・時刻は変わりうる
    .replace(/[「」（）()]/g, '')
    .replace(/\s+/g, '')
    .replace(new RegExp(MASK + '+', 'g'), MASK);
  const hay = norm(js);
  const blocks = [];
  let cur = [];
  lines.forEach((l, i) => {
    if(/^> /.test(l)) cur.push({line: i + 1, text: l.slice(2)});
    else if(cur.length){ blocks.push(cur); cur = []; }
  });
  if(cur.length) blocks.push(cur);
  blocks.forEach(b => {
    const text = b.map(x => x.text).join('').replace(/\*\*/g, '');
    text.split('。').map(x => x.trim()).filter(x => x.length > 8).forEach(sent => {
      if(hay.indexOf(norm(sent)) < 0)
        bad('引用', `README:${b[0].line} の引用が画面の文言と違います：「${sent.slice(0, 60)}」`);
    });
  });
})();

/* ---------- 照合できた表の一覧 ---------- */
if(process.argv.includes('-v')){
  console.log(`README の表 ${tables.length} 個中、照合したもの：`);
  coverage.forEach(c => console.log(
    `  ${c.found ? 'OK  ' : '未発見'} ${c.cols}` + (c.found ? ` （README:${c.line} ${c.rows}行）` : '')));
  console.log('');
}
coverage.filter(c => !c.found).forEach(c => bad('照合漏れ', `表「${c.cols}」が見つからず照合できていません`));

/* ---------- 結果 ---------- */
if(!issues.length){
  console.log('照合 OK：食い違いは見つかりませんでした');
  process.exit(0);
}
console.log(issues.join('\n'));
console.log(`\n--- ${issues.length} 件 ---`);
process.exit(1);

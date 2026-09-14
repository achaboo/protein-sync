# Protein Sync — 作業メモ

体重と運動量から1日のたんぱく質目標を決め、その日の献立・時間帯・食費・SAVASの杯数まで
設計する単一ファイルのツール。公開先は https://achaboo.github.io/protein-sync/

## ファイル

| ファイル | 中身 |
|---|---|
| `index.html` | ツール本体。HTML・CSS・JSをすべて内包（約3,800行） |
| `README.md` | 計算ロジック・定数・判定基準・1週間の型の結果。**変更のたびに必ず同期する** |
| `apple-touch-icon.png` / `favicon-192.png` | アイコン |

## 崩してはいけない前提

- **HTML1枚で完結**。外部ライブラリ・CDN・ビルド手順なし。`file://` でも GitHub Pages でも動く
- **オフラインで動く**。通信を前提にした機能を足さない
- **サーバーを持たない**。保存は `localStorage`（キー `savas-calc-v3`）。端末間は「設定リンク」で運ぶ
- 利用者は iPhone Safari（ホーム画面のアイコン）と PC Chrome の両方で開く。**狭い画面での折り返しを必ず確認する**
- 画面の文言はすべて日本語

## いまの設計（2026-09-15 / v.113）

- **たんぱく質目標＝体重 × 基本係数（初期値1.65 g/kg）**。運動量による加算はしない
  （運動量はエネルギーの必要量と④のバッジにのみ反映）
- **SAVASは明治の公式値**：1食分28g＝スプーン4杯＝たんぱく質19.5g・108kcal。
  1杯＝4.875g。1日2回まで＝8杯＝39g。初期値は「杯数を指定＝8」
- **1食40gの上限は無い**。25〜35gが目安、45g超で「分散できるなら」と添えるだけ。自動分割はしない
- **不足分の自動補正は複数候補から選ぶ**（無脂肪ヨーグルト・納豆・ツナ缶・サラダチキン）。
  食塩9.0g・飽和脂肪酸17gの線を越える候補は採用せず、足りない分は「残り○g」と表示する
- 食塩・飽和脂肪酸・エネルギーは**段階表示**（詳細は README の「判定の段階」）
- 1食の目安量は割合ではなく**gで等分**

## 作業の進め方

1. **まず `README.md` と `index.html` を読む。** 会話の記憶ではなくファイルが正
2. 編集は Node のスクリプト（`fs.readFileSync` → 文字列置換 → `writeFileSync`）で行う。
   scratchpad に置く。bash のヒアドキュメントはバッククォートを壊すので `Write` ツールで作る
3. `index.html` を変えたら **`APP_VERSION` を上げる**（`2026-09-01.NNN` 形式）
4. 構文チェック：`node -e "const s=require('fs').readFileSync('index.html','utf8');new Function(s.match(/<script>([\s\S]*)<\/script>/)[1])"`
5. **ブラウザで実際に動かして確認する**（`file:///D:/Project/repos/protein-sync/index.html`）。
   プレビューは `data:` URL のため `localStorage` が例外になる。必要なら差し替えてテストする
6. **ランダム検証を回す**：曜日・体重・基本係数・食事回数・有酸素・SAVASの設定・食事の数量を
   振って数百ケース実行し、例外・`NaN`・表示の矛盾・上限超過が無いことを確認する。
   日付は `window.Date` を差し替えて曜日を変える
7. `README.md` を同じ内容に直す（数値も実測値に置き換える）
8. コミットしてプッシュ。GitHub Pages の反映は `gh api repos/achaboo/protein-sync/pages --jq .status`

## 検証でよく使う書き方

```js
// 曜日を固定する
const RealDate = Date, base = new RealDate(2026, 8, 14);   // 月曜
window.Date = class extends RealDate {
  constructor(...a){ a.length === 0 ? super(base.getTime()) : super(...a); }
  static now(){ return base.getTime(); }
};
applyDailyDefaults();
[...document.querySelectorAll('button')].find(b => /計算する/.test(b.textContent)).click();
```

数量を変えるときは `el.value = v` だけでなく `el.dispatchEvent(new Event('input', {bubbles:true}))`
まで行う（上限の切り詰めや自動計算がこのイベントで動くため）。

## 注意

- 栄養の数値は健康に直結する。**公表値を確認してから入れる**。推定値は推定と明記する
- 週の結果の数値を README に書くときは、**実際にツールを動かして測った値**を使う
- 利用者は健診でLDLの上昇・動脈硬化指数3.3を指摘されている。
  たんぱく質を満たすために食塩や飽和脂肪酸を増やす解決はしない

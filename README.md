# Force Graph — WebGL インタラクティブグラフビューア

Force-directed (spring) layout を用いたインタラクティブなグラフ描画アプリです。

## 特徴

- **WebGL レンダリング** — ノードはポイントスプライト、エッジは GL ラインで描画。
  1 つの頂点バッファを共有するため、10,000 ノード以上の大規模グラフでも 60fps で描画できます。
- **バックグラウンドレイアウト** — レイアウト計算は Web Worker で実行され、
  ティックごとに位置だけが転送 (transferable) されるため UI はブロックされません。
- **Barnes-Hut 近似** — 反発力は四分木による Barnes-Hut 近似 (O(N log N)) で計算
  (ForceAtlas2 用に次数重み付きにも対応)。
- **複数のレイアウトモデル** — メニューで切り替え可能。いずれも alpha 減衰
  (冷却)と組み合わせて動作し、操作やパラメータ変更で自動的に再加熱されます。

  | モデル | 引力(エッジ) | 反発力 | 特徴 |
  |---|---|---|---|
  | Spring(d3-force 風) | ばね `(d−L)` 次数バイアス付き | `k/d` | 既定。安定で汎用的 |
  | Eades (1984) | `c1·log(d/c2)` | `c3/d²` | 古典的スプリングエンベッダ |
  | Fruchterman–Reingold (1991) | `d²/k` | `k²/d` | 温度で変位を制限する古典手法 |
  | ForceAtlas2 (2014) | `d`(線形) | `k·(deg+1)(deg+1)/d` | ハブが広がる。SNS系に好適 |
  | LinLog — Noack (2007) | 定数 | `k/d` | クラスタ分離が強く出る |
- **インタラクション**
  - ノードをドラッグ＆ドロップで移動(ドラッグ中はシミュレーション内で固定)
  - マウスオーバーでノードのラベルをポップアップ表示
  - 背景ドラッグでパン、ホイールでズーム
  - パネルのスライダーでレイアウトパラメータ(リンク距離・反発力・中心引力・
    慣性・リンク強度)をリアルタイムに調整可能
- **テストグラフ生成** — デフォルトで 1000 ノードの Watts–Strogatz
  スモールワールドネットワークを生成して表示します。

## 起動方法

Web Worker を使用するため、ローカルファイルではなく HTTP サーバ経由で開いてください。

```sh
python3 -m http.server 8000
# → http://localhost:8000/
```

## URL パラメータ

| パラメータ | 説明 | デフォルト |
|---|---|---|
| `graph` | 表示するグラフ JSON の URL(相対パス可) | なし(生成グラフを表示) |
| `model` | レイアウトモデル (`spring` / `eades` / `fruchterman` / `forceatlas2` / `linlog`) | `spring` |
| `n` | 生成グラフのノード数 | 1000 |
| `k` | 生成グラフの平均次数(Watts–Strogatz の k) | 6 |
| `p` | 生成グラフの再配線確率 | 0.1 |

例:

```
http://localhost:8000/                              # 1000ノードのスモールワールド
http://localhost:8000/?n=10000                      # 10000ノードでスケールテスト
http://localhost:8000/?graph=data/sample.json       # 同梱サンプルを表示
http://localhost:8000/?graph=https://example.com/g.json   # 外部URL(CORS許可が必要)
```

## グラフフォーマット

できるだけシンプルな JSON 形式です。

```json
{
  "nodes": [
    "alice",
    {"id": "bob", "label": "Bob"}
  ],
  "edges": [
    ["alice", "bob"]
  ]
}
```

- `nodes` — 省略可。文字列/数値(= id)か `{id, label}` オブジェクト。
  `label` を省略すると id がそのままラベルになります。
- `edges` — `[source, target]` の配列。`{"source": ..., "target": ...}` 形式や
  `links` という名前も受け付けます(d3 系の JSON をそのまま読めます)。
- `nodes` を省略した場合、`edges` に現れた id から自動的にノードを作成します。

最小の例:

```json
{"edges": [["a","b"], ["b","c"], ["c","a"]]}
```

## ファイル構成

| ファイル | 役割 |
|---|---|
| `index.html` | UI シェル(パネル・ツールチップ・スタイル) |
| `main.js` | WebGL レンダラ、マウス操作、グラフ生成・読み込み |
| `layout-worker.js` | Force-directed レイアウト(Barnes-Hut)を実行する Web Worker |
| `data/sample.json` | フォーマットのサンプルグラフ |
| `test-worker.mjs` | レイアウトワーカーのスモークテスト(`node test-worker.mjs`) |

# iPad Native PoC v1 — 実機検証記録

記録日: 2026-10-12
検証環境: iPad / Swift Playgrounds / SwiftUI / WKWebView
GitHub Package: t-horibuchi-1207/nethack-playgrounds-test
Package version: 1.0.3 (V19 Stable resource copy)
NetHack original: t-horibuchi-1207/nethack-ios-ui tag v19-stable

## 実機で確認されたこと
- WKWebView + WKURLSchemeHandler + custom scheme nethackapp:// で NetHack WASM 起動
- Web Worker、importScripts、WASMの実行
- TensorFlow.js / EMNIST の手書き文字認識
- ASCII 縦・横表示
- TILE 縦・横表示
- セーブとセーブデータからの再開
- アプリ完全終了・再起動後もセーブデータが保持され、再開可能
- iSH/Python HTTP server なしで起動

## 重要な問題と対策
初期の URLResponse では custom scheme fetch の status が 0。
model.json は fetch で 4456 文字取得できたが、TensorFlow.js の loadLayersModel は status 0 を失敗として扱った。
WKURLSchemeHandler で HTTPURLResponse(url:statusCode:200:httpVersion:headerFields:) を返すことで手書き認識が実機で動作した。

## ソース管理
- NetHack V19 Stable本体は無変更
- SwiftUI / WKWebView wrapperの参照コードは NativePoC/ContentView.swift
- この参照コードはチャットで共有された ContentView.swift と成功報告の HTTPURLResponse 修正を基に再構成したもの
- 検証用 JavaScript (MODEL FETCH OK) は参照コードから省略
- Swift Playgroundsの実プロジェクトをGitHubへ直接同期したものではないため、完全一致は未確認

## 未確認・今後
- iPhoneでのネイティブ動作
- 長期間・複数ゲームにわたる保存の堅牢性
- App Store配布、署名、ライセンス
- Playgroundsで参照コードに差し替えた状態の再検証

## GitHub保存版の再現性検証（2026-10-12）

ユーザーがSwift Playgroundsで既存アプリを複製し、GitHubの `NativePoC/ContentView.swift` を全文貼り付けて実機で再検証。次のすべてについて成功を報告した。

- NetHack WASM起動
- TensorFlow.js手書き文字認識
- ASCII縦画面・横画面
- TILE縦画面・横画面
- セーブと再開
- アプリ完全終了・再起動後のセーブ保持と再開

結論: GitHubに保存したSwift参照コードは、既存アプリとは別のPlaygrounds複製環境でも再現動作した。

注意: この記録は実機でのユーザー報告に基づく。iPhoneでの実行、App Store配布は未検証。

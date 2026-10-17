# NetHack iOS — 初回TestFlight配信成功記録

記録日: 2026-10-17

## 構成
- NetHack UI: V19 Stable（ゲーム本体の安定版）
- Swift Package: NetHackWebTest 1.0.5
- iOSアプリ: NetHack iOS 1.0 (build 1)
- 開発環境: iPad / Swift Playgrounds
- 配信: App Store Connect / TestFlight 内部テスト
- 保存用ブランチ: release/ios-1.0（1.0.5タグを起点に作成）

## 実機確認結果
- iPad: NetHack起動・操作成功
- App Store Connect: アップロード成功
- TestFlight: iPhoneへのインストール成功
- iPhone: NetHack起動・操作成功
- セーブ: アプリ終了・再起動後の復元成功

## 注意
- この記録はユーザーが実機で確認した結果に基づく。
- Swift Packageの構成を保存するブランチであり、Swift Playgrounds側のアプリプロジェクト全体をGitHubに保存したことを意味しない。
- 以後の開発ではV19 Stableおよび1.0.5タグを変更せず、別ブランチ・別バージョンで検証する。

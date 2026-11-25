# 技能：抖音收藏夹只读学习（可配置目标）

## 何时用

用户要求学习抖音收藏夹视频时使用本插件。目标收藏夹由 `douyin_config` 的配置决定（默认 `dsh`），不写死；只学精确匹配的那个夹。

## 流程

1. 先调 `douyin_config` 的 `get` 确认当前 learnable（学习目标）与 archived（归档目标）。用户若要换夹，先 `set`。
2. 调 `douyin_dsh_folders`：确认存在精确名等于 learnable 的收藏夹。未找到就停止，不读其它收藏夹。
3. 调 `douyin_dsh_pending`：只取目标夹中未学视频；对话里只用 id+标题摘要，详情按返回的文件路径再读。
4. 学完后调 `douyin_dsh_mark` 传入视频 id，写入已学账本。
5. 如用户要求归档，调 `douyin_dsh_archive_prepare` 给出人工步骤，并明确说明归档尚未自动验证。

## 禁止

- 模糊匹配收藏夹名，例如把 `dsh已学` 当成 `dsh`。
- 读推荐、精选、喜欢、默认收藏夹或其它收藏夹。
- 盲点 `[data-e2e="video-player-collect"]` 等隐藏控件；它会翻转真实收藏状态。
- 在没有核对数量变化前宣称视频已移入归档夹。

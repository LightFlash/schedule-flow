# Schedule Flow · 个人日程 + 工作汇总工具

基于 Electron + React 的桌面工具，包含番茄时钟、TODO、独立工作计时与周期汇总。所有数据本地保存，不联网也能使用（微信推送除外）。

## 一、直接运行（无需源码）

打开 `dist/` 目录：

- **安装版**：双击 `Schedule Flow-1.0.0-x64.exe`，按向导安装（可自选目录，会创建桌面/开始菜单快捷方式）。
- **便携版**：解压 `Schedule-Flow-1.0.0-portable.zip`，运行其中 `win-unpacked/Schedule Flow.exe`，免安装、可放U盘。

> 首次运行若被 Windows Defender / 杀软提示，选择"允许"（Electron 应用未做代码签名）。

## 二、功能说明

| 模块 | 功能 |
| --- | --- |
| 番茄钟 | 自定义工作/休息时长与轮次；开始/暂停/继续/重置；到点窗口置顶 + 高亮闪烁 + 微信推送强提醒（需手动确认）；后台计时，切换页面不中断；小窗模式下设置按钮在右上角展开 |
| TODO | 新建/编辑；完成勾选与完成时间；**行尾直接开始/暂停/继续/停止计时**（无需展开）；**备注/心得为富文本**（加粗/斜体/下划线/列表/标题，点开浮层编辑并保存）；**删除带二次确认**；显示每项累计用时 |
| 工作计时 | 每项工作独立计时；开始/停止/暂停/继续；累计用时自动累加；同一时刻只允许一项计时；关闭或崩溃后按真实时间恢复 |
| 汇总 | 天/周/月/年四种粒度；完成任务数、累计工作用时、完成番茄数；每项工作明细可展开 |
| 极简模式 | 侧边栏可切换「极简模式」：番茄钟与 TODO 变成两个可**拖动 / 缩放 / 单独关闭重开 / 置顶**的浮层小窗；置顶按钮为图标 + 蓝色实心状态；可随时切回标准模式 |
| 数据管理 | 侧边栏「数据管理」：一键**导出 JSON 备份**、**导入恢复**、**自动备份开关**（退出时留带日期副本）；数据存用户目录，更新/重装不丢 |
| 设置 | 配置 Server酱 / PushPlus 推送凭证并测试；番茄钟默认参数；完成后自动标记开关 |

## 三、微信推送配置（可选）

1. 在「设置」弹窗中选择渠道：
   - **Server酱 Turbo**：到 <https://sct.ftqq.com/> 用微信扫码登录，复制 SendKey（`SCT` 开头）。
   - **PushPlus**：到 <https://www.pushplus.plus/> 用微信扫码登录，复制 Token。
2. 粘贴到对应输入框并保存，点击「测试推送」确认手机收到。
3. 两个渠道可同时填写，会同时推送；推送失败不会影响本地窗口置顶提醒。
4. 不填凭证时，到点只做本地强提醒（窗口置顶 + 闪烁），界面会给出提示。

## 四、源码构建（Windows，Node ≥ 18）

```bash
npm install                 # 安装依赖
npm run dev                 # 开发调试
npm run typecheck           # 类型检查
npm run build               # 构建三端产物到 out/
npm run dist                # 构建并打包 exe 到 dist/
```

打包脚本见 `electron-builder.yml`（NSIS 安装包，默认图标，不签名）。

> 常见坑：若在受限环境安装 Electron 二进制失败（临时目录 `R:\Temp` 不可写），先把环境变量 `TEMP/TMP/TMPDIR` 指向项目内可写目录，再执行 `node node_modules/electron/install.js`；打包时可用
> `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 与
> `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 走国内镜像。

## 五、测试

```bash
node tests/run.mjs          # 41 项测试（零第三方依赖，Node 内置 test runner）
```

覆盖：时间工具、汇总周期、工作计时状态机、番茄状态机、提醒/推送、IPC 契约。

## 六、目录结构

- `src/shared/` 共享类型、IPC 通道、时间工具
- `src/main/` 主进程（计时引擎、持久化、推送、提醒、汇总）
- `src/preload/` 安全桥接层
- `src/renderer/` React 界面（四个视图 + 设置/提醒弹窗 + 主题）
- `docs/` PRD、系统设计、类图/时序图
- `tests/` 单元测试

## 七、数据存储与迁移

数据存于 `%APPDATA%\Schedule Flow\config.json`（不在安装目录），原子写入：

- **软件更新 / 重新安装**：不丢（不动用户目录）。
- **换电脑**：在旧机「数据管理 → 导出备份」得到 JSON，在新机「导入恢复」；或手动复制上述 `config.json` 到新机相同路径。
- **防误删**：建议打开「自动备份」，每次退出会在 `userData/backups/` 留一份带日期副本。
- 进行中的计时持久化开始时间戳，重启后按真实经过时间恢复。番茄钟与工作计时是两个独立计时器，互不干扰。

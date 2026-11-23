# dsh-mydesk

`dsh-media-desk` v2.7.2 的**副本**（改了包名，重新挂了路由与数据目录），用来在上面二次开发。
和原插件**并排共存**：两个侧栏入口同时存在，各自独立的 HTTP 路由、CSS 前缀、数据目录和导出目录，互不干扰。

原版的上游文档保留在 [`README.upstream.md`](README.upstream.md)（英文版 `README.upstream.en.md`）——功能怎么用先看它，本文只讲"这是副本"和"在哪里改代码"。

- 源码底座：GitHub `woniuniuniu/dsh-media-desk` tag `v2.7.2`（比 npm 上的已安装包多了 `client/`、`scripts/`、`test/`，所以客户端可以重新打包）
- 本机源码位置：`D:\DeepSeek Project\Test\dsh-mydesk`
- 本机已装位置：`C:\Users\msi\.dsh\profiles\desktop\node_modules\dsh-mydesk`（由 profile 以 `file:` 链接指向上面的源码目录，改源码即改运行中的插件）
- 数据目录：`C:\Users\msi\.dsh\mydesk\`（`state.json`、`settings.json`、`files/`），与原来的 `~/.dsh/media-desk` 完全分开

## 和原版差在哪

改名是全局一体的：包名一改，浏览器半片的模块 id（`dist/client.js` 里的 `__ModuleLoader__.load({id:...})`）跟着改，所以两边不会抢同一个模块。

| 东西 | 原版 | 副本 |
| --- | --- | --- |
| 包名 / 模块 id | `dsh-media-desk` | `dsh-mydesk` |
| bundle patch 里的 id | `media-desk` | `mydesk` |
| 侧栏 / 面板 id（`PANEL_ID`） | `media-desk` | `mydesk` |
| Host 路由前缀 | `/media-desk` | `/mydesk` |
| 前端请求基址（`client/desk.js` 的 `BASE`） | `media-desk/` | `mydesk/` |
| 语言请求头 | `x-media-desk-lang` | `x-mydesk-lang` |
| 素材 URL 前缀 | `media-desk/files/`、`media-desk/assets/` | `mydesk/files/`、`mydesk/assets/` |
| 拖拽 MIME | `text/media-desk-item` | `text/mydesk-item` |
| CSS 类名前缀 | `md-` | `myd-`（含 `@container myd-root`） |
| 数据目录 | `~/.dsh/media-desk` | `~/.dsh/mydesk` |
| 一键保存目录 | `~/Documents/自媒体工作台` | `~/Documents/我的工作台`（英文界面 `My Desk`） |
| 导入到技能库的名字 | `media-desk-voice` | `mydesk-voice` |
| 助手会话来源标记 | `dsh-media-desk` | `dsh-mydesk` |
| 侧栏名字 | 自媒体工作台 | 我的灵台 / My Muse Desk |

另外删掉了几个只对"发布到插件市场"才有用的东西（这个副本不上架）：
`index.json`、`scripts/build-index.mjs`、`scripts/index-entry.mjs`、`test/index.test.js`，以及 `package.json` 里的 `repository`/`homepage`/`bugs`/`index` 脚本和 `@deepseek-ai/dsh-plugin-market-index` 依赖。

版本自查仍然指向 npm 上的 `dsh-mydesk`：这个包没发布，所以检查会安静地失败，界面不会冒"有新版本"的提示。哪天真要发布，包名对上就能用。

顺手还修了两条在 Windows 上本来就红的测试（原版也一样红）：
`test/host.test.js` 里断言 `settings.json` 权限 `0o600`（Windows 没有这个权限位，改成只在 POSIX 上校验）、以及导出目录断言写死了 `/`（改成 `[\\/]`）。

## 已经加的功能：二级页面按卡片类型分化

原版点任何卡片进来都是同一个「一键成稿」页。副本按卡片类型分了三种二级页面（`client/studio.jsx` 的 `Studio()` 里按 `item.kind` 分流）：

| 卡片类型 | 二级页面 | 文件 |
| --- | --- | --- |
| 笔记 / 金句 | 二级：在画布上就地放大、可直接改（`client/inline.jsx`）；再点「放大到全屏」才是三级记录页 | `client/inline.jsx` / `client/record.jsx` |
| 网页 | 记录页：截图 + 标题 + 正文 + 原始链接 | `client/record.jsx` |
| 图片 | AI 二创台：写一句怎么改 → 生成一版；缩略图条保留每一版，可「用这张当卡片图」「在这张上接着改」「删掉这版」 | `client/art.jsx` |
| 图库 | Lovart 式工作台：左边一格格收图（点一张当参考、设为封面、看大图、删掉），右边写一句话连画几张 | `client/gallery.jsx` |
| 视频 | 保持原版的成稿页，一行没动 | `client/studio.jsx` |

笔记、金句在画布上是**两级**的：点一下先在原地放大成一张能直接改的卡片（`client/inline.jsx`，仍然留在画布上，别的卡片虚化），点卡片右上角「放大到全屏」才进全屏记录页；Esc、点空白处或「收起」退回画布。`openInline` / `closeInline` 在 `client/desk.js`。
镜头只在「放大后的卡片会被画布边缘切掉」时才挪过去（`client/canvas.jsx` 里那个 `lastInline` effect）；能完整看见就不动镜头。注意 `useCamera` 的 `x/y` 是**世界原点落在舞台上的像素位置**，不是世界坐标——按世界坐标传会让画布整体平移一大截。

二创走的是宿主的 `edit_image` 工具（真·参考图改图），所以和卡片原图是同一个人/同一个场景，不是重新描述一遍画出来的。
`src/art.js` 负责这段：给 `ctx.get('tools').execute()` 传一个**只带 `cwd` 的替身 agent**（`~/.dsh/mydesk`），让 `edit_image` 的参考图与产出都落在插件数据目录内，不用会话也能用。

- 没有 `edit_image`、或改图那一步失败时，自动退化成按提示词重画（`image_generate`），并在界面上标明这一版是「按描述重画」而不是改出来的。
- 每一版都记在 `state.json` 的 `item.art.variants` 里（最多 24 版），原图始终不动；「用这张当卡片图」才把主图换掉，可撤销。
- 后端接口：`POST /mydesk/art/remix`、`POST /mydesk/art/use`、`POST /mydesk/art/delete`；`GET /mydesk/settings` 里的 `art: { ready, edit, redraw }` 告诉界面当前能干哪一档。
- 英文词条在 `client/en/studio.js` 末尾两节。
- 二创页左侧的图不铺满：`client/styles.css` 的 `.myd-art-frame` 留出画布留白（`padding: 42px 48px`），图自己带圆角与投影，像一张浮在工作台上的片子。
- 画幅按钮的文字居中对齐：根选择器 `:where(.myd-root) button` 里的 `text-align: inherit` 会让它继承左对齐，`.myd-art-ratios button` 要显式写回 `center`。
- 内联卡片里的长笔记要能滚：`.myd-inline` 是 `display:flex; flex-direction:column`，`Grow` 把 textarea 的 `height` 设成 `scrollHeight`，但 textarea 默认 `flex-shrink:1`，会被卡片 `max-height` 压回去——卡片 `scrollHeight` 恰好等于 `clientHeight`，于是正文被裁掉、还没有滚动条。必须给 `.myd-inline textarea` 写 `flex: 0 0 auto`，让内容真的溢出，`overflow-y:auto` 才生效。
- 滚轮归属：画布的滚轮监听挂在 `.myd-stage` 上（`client/canvas.jsx` 的 `onWheel`，无条件 `preventDefault` 后平移/缩放）。内联卡片打开时，命中 `.myd-inline` 就**自己**改 `card.scrollTop`（`deltaMode` 为行时乘 16），既不吃画布手势，也不依赖浏览器把滚轮从 `overflow:hidden` 的 textarea 往祖先 scroller 上链。
- 内联卡片的高度上限是 `min(620px, 78vh)`，窗口矮的时候不会顶出屏幕。

## 已经加的功能：图库（`kind: 'gallery'`）

底部筛选条（图片 / 视频 / 网页 / 金句 / 笔记）后面多了一个 **图库**；「＋」新建里也多了「图库」一栏，建完直接进二级页。

- 图库卡片本身就是容器：图全存在 `item.art.variants` 里（跟图片二创同一个字段、同一套 `variantAction`），`item.media.src` 用第一张当封面。所以撤销、导出、备份都不用改。
- 画布上的卡片是四宫格预览（`client/card.jsx` 的 `GalleryCover`），没图时写「空的图库」，超过 4 张时右下角标总数。
- 二级页铺满屏幕，比例照图片二创页：左边 `flex:1` 收图，右边 336px 面板（`client/gallery.jsx`）。左栏每张图悬停出三个按钮（看大图 / 设为封面 / 删掉），点整张就「选中当参考」（角标「参考图」），再点一次取消。
- 右侧：一句话提示词 + 六个快捷想法 + 画幅（默认/1:1/3:4/4:3/9:16/16:9）+ 这次画几张（1/2/4）+ 「画出来」；有参考图时改图（`edit_image`），没有就文生图（`generate_image`）。
- 本地图片有两种进图库的方式，都不经过生图模型：**把图片拖到页面上**（松手处有虚线框提示，一次最多 24 张）、或者 **Ctrl+V 粘贴截图**（只认剪贴板里的图片，粘文字照常）。先走原有的 `POST /mydesk/upload` 落到 `files/`，再用 `POST /mydesk/art/add` 挂成一版（`mode: 'upload'`）；同一张重复拖不会收两次。图库本来没有封面时，收进来的第一张当封面。
- 后端一条接口：`POST /mydesk/art/gallery`（`src/art.js` 的 `galleryMake`），一次最多画 4 张，`item.art.variants` 最多留 120 张（`GALLERY_MAX`）；单张失败只交成功的那些，全失败才报错。
- 文生图工具的参数按工具自己的声明来发：`drawArgs()` 看到 `aspect_ratio` 就传画幅，只认 `size` 就把画幅映射成 `SIZE_OF` 里的 `1024x1024 / 1536x1024 / 1024x1536`，枚举里没有就退 `auto`。
- 助手也能建图库：`add_item { kind: 'gallery' }`（`src/ops.js` 的 `KINDS`、`src/ai.js` 的 `OP_DOC` 已同步）。
- 左栏有**两种预览模式**（头部「预览模式」切换，选择会存在卡片上）：「缩略图」是一张张方图排下去；「铺开」把整个左栏变成一块能拖能缩的画布（`client/board.jsx` 的 `GalleryBoard`），图片按**原始比例**摆着，不裁不缩。
  - 画布：拖空白处平移，滚轮以光标为中心缩放（20%–400%），底部条有「适应窗口」和点百分比回 100%。
  - 图片：点一张选中（描边），Shift/Cmd 点击增减选；拖任意一张会带着**整组/整个选区**一起动；方向键微移 1px（按 Shift 是 10px）。
  - 对齐：底部工具条六个方向（左/横中/右/上/纵中/下）按选区包围盒对齐，横、纵均分要求至少 3 张（两端不动、中间等距）。
  - 吸附：拖动时选区的左/中/右、上/中/下 会自动贴到别的图的同名基准上，屏幕上差 7px 以内就吸住（缩放越大，世界坐标里的吸附距离越小），吸住时画一条参考线；按住 **Alt** 拖可临时关掉。纯数学在 `client/snap.js`（`snapDrag` / `snapDragFrom`），组件只负责把它接到指针事件上。
    - 不抖的两个前提：① 吸住之后**锁住这个基准**（`SNAP_HOLD`，只有真拉出吸附距离才换），否则两个候选基准挨得近时指针原地一毫米来回就会在两个目标之间跳；② 算包围盒要用**按下时的位置**（`snapDragFrom` 的 `start`），拿当前位置算会把位移每帧重复加一遍，拖久了吸附会在完全无关的地方触发。
  - 组合：「组合」给选中的几张打同一个 `group` 标记，之后点其中任意一张就整组选中一起拖；「取消组合」只删标记，不动位置。
  - 落盘：位置/缩放/平移存在 `item.art.board`（`normalizeBoard` 会把越界值夹回来、最多 300 条），改完 700ms 防抖存一次，走 `POST /mydesk/art/board`，**不进撤销栈**（排版不算内容改动），刷新后回来还是原样。
  - 新图第一次进「铺开」时按原比例自动货架式排一下（行宽 1480，行距 26），已经在画布上的图不会被重排。

## 已经加的功能：生图来源多一档「桥接到 image-gen」

设置 → 生图来源 现在是三个按钮：`图片 API` / `DSH 生成工具` / `桥接到 image-gen`（`client/settings.jsx`）。第三档是**内置**的，不用再装额外插件：

- 实现在 `src/bridge.js`：只认 dsh-image-gen 注册的 **`generate_image`**，用只带 `cwd` 的替身 agent 调 `ctx.get('tools').execute(...)`，再把成品从 `~/.dsh/mydesk` 下读回来（也接受 `output` 里的 data URL）。工作台没有聊天会话，替身 agent 让它把插件数据目录当作会话工作区，参考图与成品都不出圈。
- 为什么和 `DSH 生成工具` 分开：那一档按别名优先挑任意订阅生图工具（`src/image-tool.js` 的 `NAMES`，先试 `dsh_subscriptions_image_generate`，成品必须落在 `~/.dsh/plugins/subscriptions/images/`）；桥接这一档只转 `generate_image`，两者可用性分开算（`imageToolAvailable` / `imageBridgeAvailable`）。
- `image.source` 的白名单是 `['http', 'tool', 'bridge']`；`src/settings.js` 的 `imageReady()` 对 `'bridge'` 看 `imageBridgeAvailable`，`publicSettings` 会把它一起发给界面。
- `src/host.js` 的 `imageAvailability(ctx)` 用 `imageTool(ctx)` 与 `bridgeTool(ctx)` 各算一个布尔，`imageMissingMessage(source)` 按来源给提示；`GET/POST /mydesk/settings`、`POST /mydesk/settings/test` 与 `Producer` 的 `ready/generate` 都用它们，所以「试画一张」在桥接模式下走的是 `generate_image`。
- 界面照着 `imageBridgeAvailable` 说人话：检测到就说请求会直接转给 image-gen，没检测到就提示先在 DSH 里装好并启用 dsh-image-gen。
- 尺寸/质量仍走 `toolSize` / `toolQuality`（按内层工具自己声明的枚举发，声明里没有就不发），用哪个服务、哪个模型完全由 dsh-image-gen 自己的设置决定。

## 目录

```
src/            host 半片：Node 侧。路由、存储、AI 调用、导出、图片工具、Monid 导入
  host.js       /mydesk/* 的全部接口（一个 switch 走完）
  store.js      状态读写 + 三方合并式撤销（最多 30 步）
  settings.js   settings.json（图片通道、助手、导出目录…），密钥只回 keyHint
  ai.js         模型调用与提示词
  ops.js        助手改数据的操作白名单与校验
  export.js     一键保存成文件夹
  seed.js       首次打开时的示例数据（图片用 mydesk/assets/...）
  image-tool.js 把订阅画图能力包成一个 DSH 工具给模型用
  bridge.js     「桥接到 image-gen」：内置转调 generate_image（不需要额外插件）
  art.js        图片二创与图库连画：替身 agent 调 edit_image / generate_image
  i18n.js       中英切换（英文词典在 src/en.js）
client/         浏览器半片源码（jsx + styles.css），ESM 源码，不是最终产物
  index.jsx     侧栏入口、5 个导航页、全局面板
  desk.js       所有 fetch（基址 'mydesk/'，带 x-mydesk-lang）
  studio.jsx    创作流程最重的一个页面，按卡片类型分流二级页面
  inline.jsx    笔记 / 金句在画布上就地放大的二级页
  record.jsx    笔记 / 金句 / 网页的记录页
  art.jsx       图片二创台
  gallery.jsx   图库：左边收图，右边连画（缩略图 / 铺开两种预览）
  board.jsx     图库的「铺开」画布：平移、缩放、拖动、对齐、组合
  snap.js       拖动吸附的数学（只算坐标和参考线，不碰 React）
  styles.css    全部样式（类名一律 myd- 前缀）
  en/           英文词典（key 是中文原文）
dist/client.js  打包产物：npm run build 生成，别手改
assets/         示例图与素材（打包进插件）
test/           node --test 测试，140 条全绿
scripts/        构建（build.mjs）与本地开发工具（mock 模型、mock monid、沙箱启动）
```

## 常用命令

在本目录下：

```bash
npm install        # 只需要一次，装 esbuild
npm run build      # 改完 client/ 里的东西必须跑，产出 dist/client.js
npm run watch      # 边改边构建
npm test           # 121 条测试
```

改完怎么生效：

- **只改了 `src/`**（host 半片）：停掉再启用这个 bundle，或者重启 DSH。
- **改了 `client/`**（浏览器半片）：`npm run build`，然后刷新页面（必要时 Ctrl+F5）。
- **改了 `assets/`**：不用构建，刷新即可。

装 / 重装到 profile：在 DSH 里让 agent 用 `plugin_manager` 的 `install_bundle` 指向本目录绝对路径（`D:\DeepSeek Project\Test\dsh-mydesk`），它会替你改 profile 的 `package.json`、跑 pnpm、注册 bundle。命令行等价物是 `dsh plugin --profile desktop add "file:D:/DeepSeek Project/Test/dsh-mydesk"`。

## 想加功能时先看这几处

- **加一个导航页**：`client/index.jsx` 的 `NAV` 和 `VIEWS` 各加一项 → 写个新的 `client/xxx.jsx`（导出一个组件）→ 样式加进 `styles.css`（类名用 `myd-` 打头）。页面数据从 `useDesk()` 拿。
- **加一个后端接口**：`src/host.js` 的 `route()` 里加 `case 'xxx'`，前端在 `client/desk.js` 里写对应 fetch（基址已经是 `mydesk/`）。
- **加一种助手能做的操作**：`src/ops.js` 的白名单 + 校验，`src/ai.js` 的提示词里补上这种操作的说明。
- **加一个设置项**：`src/settings.js` 的 `DEFAULTS` + `client/settings.jsx` 的表单；密钥类字段记得只回 hint，别回原文。
- **加一个给模型用的工具**：照 `src/image-tool.js` 的写法（`ctx.get('tools')` → `executable` → `execute`）。

CSS 前缀是 `myd-` 不是 `md-`：两个插件同时加载，样式都在全局作用域里，前缀一样就会互相覆盖——加新样式时别退回 `md-`。

## 数据与备份

- `C:\Users\msi\.dsh\mydesk\state.json`：全部内容（灵感、内容、排期、复盘、风格、示例数据），第一次打开时由 `src/seed.js` 生成示例。
- `C:\Users\msi\.dsh\mydesk\settings.json`：图片通道、助手模型、导出目录等。
- `C:\Users\msi\.dsh\mydesk\files\`：上传和生成的图片/视频，`state.json` 里的 `src` 形如 `mydesk/files/<名字>`，由 `/mydesk/files/<名字>` 这个路由提供。
- 撤销栈不落盘会话，最多 30 步。
- 想回到干净状态：停用插件、删掉 `~/.dsh/mydesk`、再启用。

## License

MIT，见 [`LICENSE`](LICENSE)。原版版权归 `woniuniuniu/dsh-media-desk` 作者。



# 分享、测试与发布

这个插件没有构建步骤，也没有运行时 npm 依赖。`npm pack` 出来的 tarball 就是完整插件包。

## 一、先给别人测试：发 tarball

在本目录执行：

```sh
npm pack
```

会得到 `dsh-token-billing-0.1.0.tgz`。把它发给对方即可。

对方有两种安装方式：

### 1. 普通 `dsh web` / CLI profile

```sh
dsh plugin --profile web add /absolute/path/to/dsh-token-billing-0.1.0.tgz
```

然后重启对应的 `dsh web`。

### 2. DSH Desktop

解压后，在应用的 **设置 → 插件** 里选择本地插件目录安装；或者在 DSH 会话里让 Agent 用 `plugin_manager` 的 `install_bundle`，目标传解压后的**绝对目录**：

```sh
mkdir dsh-token-billing
tar -xzf dsh-token-billing-0.1.0.tgz -C dsh-token-billing --strip-components=1
```

然后把 `/absolute/path/to/dsh-token-billing` 作为 bundle 目录安装。

> 宿主侧代码更新后需要重启桌面端，或把插件停用再启用；只刷新页面只会更新浏览器侧。

## 二、发布前确认名字

当前包名已经是 `dsh-token-billing`（截至 2026-11-10 在 npm 上未被占用），并且已经移除 `"private": true`，可以直接按下面的步骤发布。

如果以后想换成带 scope 的名字（例如 `@your-name/dsh-token-billing`），要同步三处，漏一处会导致客户端模块加载不到：

1. `package.json` 的 `"name"`；
2. `cordis.patch.yml` 里 `name:` 的值；
3. `client.js` 顶部 `window.__ModuleLoader__.load({ id: ... })` 的 `id`。

另外建议补上 `repository`、`homepage`、`author`；版本号遵循 semver，每次发布前 bump `version`。改名后先在本地重新安装一次，确认顶栏和面板仍然正常。

## 三、发布到 npm

```sh
npm login
npm publish --dry-run     # 先看文件清单
npm publish               # 未加 scope 的包默认 public
# 如果是 @scope/...：
npm publish --access public
```

发布后别人可以：

```sh
dsh plugin --profile web add dsh-token-billing
```

桌面端则通过插件市场/插件管理器按包名安装。

`npm publish` 前确认 tarball 里包含：`index.js`、`client.js`、`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`README.md`、`LICENSE`。

## 四、发布到 GitHub Release（不经过 npm 也可以）

```sh
npm pack
gh release create v0.1.0 ./dsh-token-billing-0.1.0.tgz \
  --title "v0.1.0" --notes "First public test build"
```

别人可以直接装 Release 附件：

```sh
dsh plugin --profile web add \
  https://github.com/<owner>/dsh-token-billing/releases/download/v0.1.0/dsh-token-billing-0.1.0.tgz
```

这种方式不需要 npm 账号，也适合只给几个人测试。缺点是市场里不会自动出现条目，除非另外提交目录。

## 五、提交到 DSH 插件市场/目录

社区市场 `dshmarket` 的目录来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。上架方式是去那个仓库提 PR，不是往 `dshmarket` 仓库提。

在 awesome-dsh-plugin 仓库新增一个文件：

```text
data/plugins/<github-owner>__<repo>.yml
```

内容格式（已按该仓库现行条目核对）：

```yaml
url: https://github.com/<owner>/dsh-token-billing
name: <owner>/dsh-token-billing
category: usage
description:
  en: "Title-bar usage and billing for DeepSeek Harness: today's spend, account balance, token mix, and a seven-day chart."
  zh: "DeepSeek Harness 标题栏用量与计费：今日消费、账户余额、Token 构成与近七日图表。"
```

然后按该仓库的 `contributing.md` 运行生成脚本并提交 PR。合并后，awesome-dsh-plugin 站点、`plugins.json` 索引和 `dshmarket` 通常会在一两天内收录。

如果同时发布了 npm 包，市场可以做到一键安装；只有 GitHub Release 的条目也能安装，但通常是“下载 tarball/源码”的路径。

## 六、发布前检查清单

- [ ] `npm pack --dry-run` 文件清单正确；
- [ ] 改包名后三处 id 一致；
- [ ] 在干净 profile 里安装一次，确认顶栏胶囊出现；
- [ ] 打开面板，确认余额、今日消费、Token、近七日图都有合理数值；
- [ ] 确认 `GET /api/token-billing/summary` 返回 200；
- [ ] 确认没有把本机绝对路径、账号 token、余额账本等私人数据打进 tarball；
- [ ] README 里换成发布后的安装命令；
- [ ] 版本号已 bump，CHANGELOG/Release notes 写清楚数据口径（余额估算、缓存余额等）。

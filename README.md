# 股票模拟交易系统

一个使用 Vue 3、TypeScript 和 Node.js / Express 实现的股票模拟交易应用。用户、订单和成交记录都保存在内存中，**后端重启后数据清空**，无需安装数据库。

## 功能说明

- 注册、登录和退出。每个新账户有 100 万虚拟币，初始持仓为空。
- 展示三只股票的代码、名称、最新价和涨跌幅，行情每秒随机小幅波动。
- 支持限价买入、卖出，按价格优先、时间优先撮合，支持部分成交，并更新资金与持仓。
- 查看当前委托、历史委托、持仓和最近成交，以及可用和冻结的资金、持仓。
- 通过 WebSocket 推送行情、委托、持仓和成交变化，断线后自动重连并同步最新状态。
- 下单响应丢失时，可以按原请求标识重试；刷新页面后可恢复待确认委托，避免重复成交。

默认提供有限的系统买卖挂单，新用户注册后即可尝试交易。模拟行情的涨跌与撮合分开处理，只有实际委托匹配才会产生交易。操作示例见[双账户交易演示](docs/功能演示.md)。

## 启动步骤

需要 Node.js **22.14+（22.x）或 24.x**、npm **10+**。

### 本地开发

```bash
git clone https://github.com/ep-12221/stock-project.git
cd stock-project
npm ci
npm run dev
```

一个命令同时启动前后端：前端为 [localhost:5173](http://localhost:5173)，后端为 [localhost:3000](http://localhost:3000/api/health)。打开前端注册账户即可使用，按 Ctrl+C 停止服务。

默认无需配置文件。如需修改后端端口或关闭系统挂单，可参考 [.env.example](.env.example)，在项目根目录创建 .env。

### 构建后运行

先停止开发服务，再执行：

```bash
npm run build
npm start
```

访问 [localhost:3000](http://localhost:3000)。此时由后端同时提供前端静态页面、REST API 和 WebSocket。

### Docker

需要先启动 Docker Engine 或 Docker Desktop。在 Windows 的 WSL 中运行时，还需在 Docker Desktop 的 Settings → Resources → WSL Integration 中启用当前发行版，确认 `docker info` 能显示 Server 信息后，再在项目目录执行：

```bash
docker compose up --build
```

访问 [localhost:3000](http://localhost:3000)。运行前确保 3000 端口空闲，结束后用 `docker compose down` 清理容器。

## 关键架构决策

1. **在单个后端进程中保存业务状态。** 按题目要求使用内存存储，HTTP 接口、撮合引擎和 WebSocket 读取同一份账户与订单数据。部署简单，代价是重启会丢失数据，不能直接扩展为多个实例。
2. **金额使用整数分，撮合完成后一次提交结果。** 整数计算避免浮点误差；先计算成交、冻结和结算结果，通过资金与持仓校验后再更新内存，防止操作失败时只改了一部分账户数据。
3. **HTTP 处理操作，WebSocket 同步状态。** 下单通过 HTTP 得到明确响应，行情与账户变化通过 WebSocket 推送。快照带有版本，重连后重新同步，防止旧响应覆盖新数据。

## 测试

```bash
npm run check
```

依次执行类型检查、Lint、格式检查、测试和生产构建。目前包含 553 项测试，覆盖撮合优先级、部分成交、资金守恒、用户隔离、断线恢复和下单幂等等场景。详细结果见[验收记录](docs/交付验收与清单.md)。

开发约定：新增功能或修复问题时，先补测试并确认失败，再实现并完成回归。

## AI 协作记录

[关键 Prompt 记录](docs/AI协作记录.md)整理了四次协作，包含当时的问题、提示词和后续处理。更多实现说明见[详细设计](docs/股票模拟交易系统详细实现文档.md)。

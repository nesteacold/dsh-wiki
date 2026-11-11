// dsh-wiki — MCP 的 stdio 传输（spec 015）。
//
// MCP stdio 的分帧是“一行一条 JSON-RPC 消息、消息内不得有换行”。这一层只做分帧与串行化：
// 请求按到达顺序**排队**处理，所以同样的输入一定得到同样的响应顺序（评测/测试依赖这一点）。
// stdout 只承载协议帧，日志一律走 stderr —— 任何多余字节都会让客户端解析失败。
//
// EOF 的语义是“不会再有新请求”，**不是**“丢掉已经排队的响应”：客户端常常连写几条请求就关掉 stdin
// （一次性脚本、`claude mcp list` 这类探测），而 CLI 收到 EOF 后会立刻退出进程。所以 close() 必须
// 先等队列跑完，再等这些字节真的被 stdout 收下（write 的完成回调），最后才允许进程退出——
// 否则写到管道缓冲里的响应会随 process.exit 一起消失。
import readline from "node:readline";
import { RPC, dispatchPayload, rpcError } from "./protocol.mjs";

// 排空上限：客户端若不读 stdout，写完成回调永远不会来；这种客户端已经走了，不能把服务器挂死。
const FLUSH_TIMEOUT_MS = 5000;

/**
 * @param {{dispatch: Function}} server protocol.createMcpServer() 的返回值
 * @param {{input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, flushTimeoutMs?: number}} options
 */
export function attachStdio(server, { input = process.stdin, output = process.stdout, flushTimeoutMs = FLUSH_TIMEOUT_MS } = {}) {
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  // 只有 close() 收尾之后才停止写入：那时 stdout 已经可以随进程一起关掉了。
  let writable = true;

  // 客户端提前断开是正常结局（它先走了）；不能让 stdout 的 EPIPE 变成未捕获异常把进程炸掉。
  output.on?.("error", () => { writable = false; });

  const write = (body) => {
    if (!body || !writable) return;
    const chunk = `${JSON.stringify(body)}\n`;
    const accepted = new Promise((resolve) => {
      try {
        output.write(chunk, () => resolve());
      } catch {
        resolve(); // 管道已断开：没有可报告的
      }
    });
    pending.add(accepted);
    void accepted.then(() => pending.delete(accepted));
  };

  let queue = Promise.resolve();

  reader.on("line", (line) => {
    const text = line.trim();
    if (text.length === 0) return;
    // 这里**不**检查 EOF 状态：行已经读到了，它就必须有响应。
    queue = queue.then(async () => {
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        write(rpcError(null, RPC.parse, "Parse error: line is not valid JSON"));
        return;
      }
      let response;
      try {
        response = await dispatchPayload(server, payload);
      } catch {
        response = rpcError(null, RPC.internalError, "the request could not be completed");
      }
      write(response);
    });
  });

  return {
    /** 等队列跑完、等 stdout 收下这些字节；进程退出由 CLI 负责。 */
    async close() {
      await queue.catch(() => {});
      if (pending.size > 0) {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((resolve) => { setTimeout(resolve, flushTimeoutMs).unref?.(); }),
        ]);
      }
      writable = false;
      reader.close();
    },
  };
}

/**
 * MCP Server - 认证相关工具
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayManager } from "../../core/gateway/manager.js";
import { getConfig } from "../config.js";
import { handleError } from "../utils.js";

export function registerAuthTools(
  server: McpServer,
  gatewayManager: GatewayManager
): void {
  const config = getConfig();

  // ==================== mijia_auth ====================
  server.registerTool(
    "mijia_auth",
    {
      title: "连接米家网关",
      description: `连接米家网关并建立认证 Session。

此工具必须在调用其他任何工具之前调用，用于建立与米家网关的安全连接。

Args:
  - passcode (string): 6位数字登录码，从网关设备上获取
  - gateway_url (string, optional): 网关地址。未提供时使用 MCP 配置的 GATEWAY_URL 环境变量；两者都没有时会返回错误，请提供地址

Returns:
  - success: boolean - 连接是否成功
  - message: string - 连接状态信息

Error Handling:
  - "登录码格式错误" - passcode 不是6位数字
  - "未配置网关地址" - 未提供 gateway_url 且未设置 GATEWAY_URL，请提供网关地址
  - "网关连接失败" - 无法连接到网关地址
  - "认证失败" - 登录码不正确`,
      inputSchema: z.object({
        passcode: z.string().regex(/^\d{6}$/, "必须是6位数字").describe("6位数字登录码"),
        gateway_url: z.string().url().optional().describe("网关地址，可选；缺省时使用 GATEWAY_URL 环境变量，两者都无则报错"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ passcode, gateway_url }) => {
      if (gatewayManager.isConnected()) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: "已连接。如需换登录码，请先调用 mijia_forget_auth 再重新 mijia_auth" }) }],
          isError: true,
        };
      }
      try {
        const url = gateway_url || config.gatewayUrl;
        if (!url) {
          return {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: "未配置网关地址：请在 gateway_url 参数中提供网关地址，或在 MCP 配置里设置 GATEWAY_URL 环境变量" }) }],
            isError: true,
          };
        }
        await gatewayManager.connect(passcode, url);
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: "连接成功", gateway_url: url }) }],
          structuredContent: { success: true, connected: true, gateway_url: url },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // ==================== mijia_disconnect ====================
  server.registerTool(
    "mijia_disconnect",
    {
      title: "断开网关连接",
      description: `断开与米家网关的 WebSocket 连接（保留已保存的凭据）。

断开后任何工具调用会自动用保存的凭据重连，无需重新输入登录码。
如需彻底注销并删除保存的登录码，请调用 mijia_forget_auth。`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        await gatewayManager.disconnect();
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: "已断开（凭据已保留，下次调用自动重连）" }) }],
          structuredContent: { success: true, connected: false, credentialSaved: gatewayManager.credentialSaved() },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // ==================== mijia_forget_auth ====================
  server.registerTool(
    "mijia_forget_auth",
    {
      title: "彻底注销（删除保存的登录码）",
      description: `断开连接并删除本机保存的网关登录码（macOS Keychain / 本地文件）。

之后需要重新调用 mijia_auth 输入新的登录码才能连接。
与 mijia_disconnect 的区别：disconnect 只断线不删凭据，forget_auth 彻底注销。`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        await gatewayManager.forget();
        return {
          content: [{ type: "text", text: JSON.stringify({ success: true, message: "已断开并删除保存的登录码" }) }],
          structuredContent: { success: true, connected: false, credentialSaved: false },
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // ==================== mijia_status ====================
  server.registerTool(
    "mijia_status",
    {
      title: "检查连接状态",
      description: `检查与米家网关的连接状态。

Returns:
  - connected: boolean - 当前是否已连接
  - credentialSaved: boolean - 本机是否保存了登录凭据
  - credentialBackend: "keychain" | "file" | null - 凭据存储位置
  - canAutoReconnect: boolean - 断线后能否自动恢复连接`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const connected = gatewayManager.isConnected();
      const credentialSaved = gatewayManager.credentialSaved();
      return {
        content: [{ type: "text", text: JSON.stringify({ connected, credentialSaved, credentialBackend: gatewayManager.credentialBackend(), canAutoReconnect: credentialSaved }) }],
        structuredContent: { connected, credentialSaved, credentialBackend: gatewayManager.credentialBackend(), canAutoReconnect: credentialSaved },
      };
    }
  );
}

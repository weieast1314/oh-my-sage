/**
 * MCP Server - 设备管理工具
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GatewayManager } from "../../core/gateway/manager.js";
import { getDevices, getDevice, findDeviceUsage } from "../../core/index.js";
import {
  ResponseFormatSchema,
  formatJson,
  handleError,
  formatDeviceListMarkdown,
  formatDeviceDetailsMarkdown,
  formatDeviceUsageMarkdown,
} from "../utils.js";

export function registerDeviceTools(
  server: McpServer,
  gatewayManager: GatewayManager
): void {
  // ==================== mijia_get_devices ====================
  server.registerTool(
    "mijia_get_devices",
    {
      title: "获取设备列表",
      description: `获取已连接网关下的所有设备列表。

返回设备的基本信息，包括ID、名称、型号、在线状态和房间信息。

Args:
  - response_format (string, optional): 输出格式，"markdown" 或 "json"，默认 "markdown"

Returns:
  - devices: 设备列表
  - count: 设备数量

Error Handling:
  - "网关未连接" - 请先调用 mijia_auth`,
      inputSchema: z.object({
        response_format: ResponseFormatSchema.optional().default("markdown").describe("输出格式"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ response_format = "markdown" }) => {
      try {
        await gatewayManager.ensureConnected();
        const result = await getDevices(gatewayManager.gateway!);

        if (!result.success) {
          return {
            content: [{ type: "text", text: handleError(new Error(result.error), "get_devices") }],
            isError: true,
          };
        }

        const devices = result.data ?? [];
        const output = { devices, count: devices.length };

        if (response_format === "json") {
          return {
            content: [{ type: "text", text: formatJson(output) }],
            structuredContent: output,
          };
        }

        return {
          content: [{ type: "text", text: formatDeviceListMarkdown(devices, devices.length) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error, "get_devices") }],
          isError: true,
        };
      }
    }
  );

  // ==================== mijia_get_device ====================
  server.registerTool(
    "mijia_get_device",
    {
      title: "获取设备详情",
      description: `获取指定设备的详细信息，包括 MIOT Spec 能力定义。

返回完整 MIOT Spec 能力：所有属性的读写订阅权限、类型、单位、枚举取值、数值范围，以及事件参数和动作输入参数。同时返回该设备的完整 URN，构造规则节点的 cfg.urn 时直接使用，不要从型号字符串推导版本号。排查设备映射时优先使用本工具，无需先读取日志。

Args:
  - dids (string[]): 设备ID数组，支持批量查询
  - response_format (string, optional): 输出格式，默认 "markdown"

Returns:
  - devices: 设备详情列表
  - notFound: 网关设备表中不存在的设备ID列表（为空表示全部命中）
  - 每个设备含 urn: 完整 MIOT URN，规则节点 cfg.urn 必须与之完全一致
  - 包含 properties(所有字段约束), events(事件及参数), triggers, actions(含输入参数), readable
  - 每个设备含 found 字段：false 表示该ID在网关设备表中不存在，其余字段为占位空值

Error Handling:
  - "网关未连接" - 请先调用 mijia_auth
  - 设备ID不存在时不报错，而是在该设备的 found=false 并列入 notFound；请勿把它当作「设备离线」`,
      inputSchema: z.object({
        dids: z.array(z.string()).min(1).describe("设备ID数组"),
        response_format: ResponseFormatSchema.optional().default("markdown").describe("输出格式"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dids, response_format = "markdown" }) => {
      try {
        await gatewayManager.ensureConnected();
        const result = await getDevice(gatewayManager.gateway!, dids);

        if (!result.success) {
          return {
            content: [{ type: "text", text: handleError(new Error(result.error), "get_device") }],
            isError: true,
          };
        }

        const devices = result.data ?? [];
        const notFound = devices.filter((device) => device.found === false).map((device) => device.did);
        const output = { devices, count: devices.length, notFound };

        if (response_format === "json") {
          return {
            content: [{ type: "text", text: formatJson(output) }],
            structuredContent: output,
          };
        }

        return {
          content: [{ type: "text", text: formatDeviceDetailsMarkdown(devices) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error, "get_device") }],
          isError: true,
        };
      }
    }
  );

  // ==================== mijia_find_device_usage ====================
  server.registerTool(
    "mijia_find_device_usage",
    {
      title: "查询设备被哪些自动化规则引用",
      description: `一次扫描全部自动化规则，找出引用了指定设备的规则和节点。

替代逐条 mijia_get_graph 翻查。更换、拆除、排查设备前先用本工具确认影响范围。

Args:
  - dids (string[], optional): 设备ID数组。已从网关删除的设备ID同样可查，用于排查残留引用
  - query (string, optional): 名称/型号/房间/设备ID的模糊匹配，不区分大小写。型号同时匹配 model 串(如 linp-es5b)与中文型号名
  - response_format (string, optional): 输出格式，默认 "markdown"
  - dids 与 query 至少提供一个；两者同时提供时取并集

Returns:
  - devices: 每个设备命中的规则列表，含节点ID、节点类型、角色(trigger 触发 / read 读取 / write 控制)、siid/piid/eiid/aiid
  - orphans: 规则引用了但网关设备表中已不存在的设备ID及其规则名，为空表示没有残留引用
  - scannedGraphs: 本次扫描的规则总数
  - unreadableGraphs: 读取失败的规则ID，非空说明这些规则的引用情况未确认

Error Handling:
  - "网关未连接" - 请先调用 mijia_auth
  - "必须提供 dids 或 query 之一"
  - query 无匹配时返回错误，请先用 mijia_get_devices 确认名称

Note: 需要逐条拉取规则，规则较多时耗时数秒。`,
      inputSchema: z.object({
        dids: z.array(z.string()).optional().describe("设备ID数组"),
        query: z.string().optional().describe("名称/型号/房间/设备ID模糊匹配"),
        response_format: ResponseFormatSchema.optional().default("markdown").describe("输出格式"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ dids, query, response_format = "markdown" }) => {
      try {
        await gatewayManager.ensureConnected();
        const result = await findDeviceUsage(gatewayManager.gateway!, { dids, query });

        if (!result.success) {
          return {
            content: [{ type: "text", text: handleError(new Error(result.error), "find_device_usage") }],
            isError: true,
          };
        }

        const report = result.data ?? { devices: [], orphans: [], scannedGraphs: 0, unreadableGraphs: [] };
        const output = { ...report };

        if (response_format === "json") {
          return {
            content: [{ type: "text", text: formatJson(output) }],
            structuredContent: output,
          };
        }

        return {
          content: [{ type: "text", text: formatDeviceUsageMarkdown(report) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: handleError(error, "find_device_usage") }],
          isError: true,
        };
      }
    }
  );
}

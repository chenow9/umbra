"use client";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Command } from "cmdk";
import { ArrowUpRight, Plus, Search, Radio, Activity, Settings2 } from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { listMappings, listNodes } from "@/lib/umbra/api";
import { serviceState, targetAddress } from "@/lib/umbra/service";

export function QuickLauncher() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const mappings = useQuery({
    queryKey: ["umbra", "mappings"],
    queryFn: listMappings,
    enabled: open,
  });
  const nodes = useQuery({ queryKey: ["umbra", "nodes"], queryFn: listNodes, enabled: open });
  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        if (
          !open &&
          document.querySelector('[role="dialog"]:not([data-workspace-inspector="true"])')
        )
          return;
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [open]);
  const go = (to: "/mappings" | "/nodes" | "/traffic" | "/deploy", search = {}) => {
    setOpen(false);
    void navigate({ to, search });
  };
  return (
    <>
      <button
        className="quick-launch-trigger"
        aria-label="快速查找服务和操作"
        onClick={() => setOpen(true)}
      >
        <Search className="size-4" />
        <span>快速前往</span>
        <kbd>⌘ / Ctrl K</kbd>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="quick-launch-dialog max-w-xl p-0">
          <DialogTitle className="sr-only">快速前往</DialogTitle>
          <DialogDescription className="sr-only">
            搜索服务或操作，用上下方向键选择，回车打开，Escape 关闭。
          </DialogDescription>
          <Command label="查找服务与操作">
            <div className="quick-search">
              <Search className="size-5 shrink-0" />
              <Command.Input autoFocus placeholder="服务名称、节点、地址，或你要做的事…" />
            </div>
            <Command.List>
              <Command.Empty>没有匹配结果，试试服务名、端口或“添加”。</Command.Empty>
              <Command.Group heading="操作">
                <Command.Item
                  value="添加服务 新建 创建 add new"
                  disabled={nodes.isPending || nodes.isError}
                  onSelect={() =>
                    nodes.data?.some((n) => n.status !== "revoked")
                      ? go("/mappings", { create: true })
                      : go("/nodes")
                  }
                >
                  <Plus />
                  添加服务
                  <ArrowUpRight />
                </Command.Item>
                <Command.Item value="节点 接入 安装 nodes" onSelect={() => go("/nodes")}>
                  <Radio />
                  接入与管理节点
                  <ArrowUpRight />
                </Command.Item>
                <Command.Item value="观测 流量 审计 traffic" onSelect={() => go("/traffic")}>
                  <Activity />
                  查看网络观测
                  <ArrowUpRight />
                </Command.Item>
                <Command.Item value="系统 安全 主题 system" onSelect={() => go("/deploy")}>
                  <Settings2 />
                  系统与外观
                  <ArrowUpRight />
                </Command.Item>
              </Command.Group>
              <Command.Group heading="节点">
                {nodes.data?.map((node) => (
                  <Command.Item
                    key={node.id}
                    value={`节点 ${node.name} ${node.addr ?? ""} ${node.comment ?? ""} ${node.id}`}
                    onSelect={() => go("/mappings", { node: node.id })}
                  >
                    <Radio />
                    <span className="min-w-0 flex-1 truncate">{node.name}</span>
                    <span className="text-xs text-stone">{node.mappingCount} 项服务</span>
                    <ArrowUpRight />
                  </Command.Item>
                ))}
              </Command.Group>
              <Command.Group heading="服务">
                {mappings.isPending ? (
                  <p className="p-4 text-xs text-stone" role="status">
                    正在读取服务…
                  </p>
                ) : null}
                {mappings.isError ? (
                  <p className="p-4 text-xs text-rose" role="alert">
                    服务读取失败，请关闭后重试。
                  </p>
                ) : null}
                {mappings.data?.map((m) => (
                  <Command.Item
                    key={m.id}
                    value={`${m.name} ${m.nodeName} ${m.localHost} ${m.localPort} ${m.proto} ${m.id}`}
                    onSelect={() => go("/mappings", { node: m.nodeId, service: m.id })}
                  >
                    <span className="quick-service-icon">{m.proto.toUpperCase()}</span>
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-sm font-medium">{m.name}</strong>
                      <small className="block truncate text-stone">
                        {m.nodeName} · {targetAddress(m.localHost, m.localPort)}
                      </small>
                    </span>
                    <span className="text-[10px] text-stone">{serviceState(m).label}</span>
                    <ArrowUpRight />
                  </Command.Item>
                ))}
              </Command.Group>
            </Command.List>
            <div className="quick-launch-footer">
              <span>↑ ↓ 选择</span>
              <span>↵ 打开</span>
              <span>esc 关闭</span>
            </div>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

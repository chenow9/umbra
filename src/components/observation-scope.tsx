"use client";

import { useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command } from "cmdk";
import { Check, ChevronDown, Network, Radio, Search } from "lucide-react";
import type { Node } from "@/lib/umbra/types";

export function ObservationScope({
  value,
  onChange,
  nodes,
  loading,
  error,
  onRetry,
}: {
  value: string;
  onChange: (id: string) => void;
  nodes: Node[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const current = nodes.find((node) => node.id === value);
  const currentName = value
    ? (current?.name ?? (loading ? "正在读取节点…" : error ? "节点读取失败" : "所选节点不可用"))
    : "全部节点";
  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="observation-scope-trigger" aria-label={`观测范围：${currentName}`}>
          <span className="observation-scope-icon">
            {value ? <Radio className="size-4" /> : <Network className="size-4" />}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <strong>{currentName}</strong>
          </span>
          <ChevronDown className="size-4 shrink-0 text-stone" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="observation-scope-popover"
          aria-label="选择观测节点"
          align="start"
          sideOffset={8}
          collisionPadding={16}
        >
          <Command label="选择观测节点">
            <div className="observation-scope-search">
              <Search className="size-4 shrink-0" />
              <Command.Input aria-label="搜索观测节点" placeholder="搜索节点名称或地址…" />
            </div>
            <Command.List>
              <Command.Empty>没有匹配的节点。</Command.Empty>
              <Command.Group>
                <Command.Item value="全部节点 所有 网络 all" onSelect={() => pick("")}>
                  <Network className="size-4 shrink-0" />
                  <span className="flex-1">
                    <strong>全部节点</strong>
                    <small>查看整个网络的流量</small>
                  </span>
                  {!value ? <Check className="size-4" aria-label="当前范围" /> : null}
                </Command.Item>
              </Command.Group>
              {loading ? (
                <p role="status" className="p-3 text-xs text-stone">
                  正在读取节点…
                </p>
              ) : error ? (
                <div role="alert" className="p-3 text-xs text-rose">
                  节点读取失败。
                  <button className="ml-2 underline" onClick={onRetry}>
                    重新加载
                  </button>
                </div>
              ) : (
                <Command.Group heading={`节点 · ${nodes.length}`}>
                  {[...nodes]
                    .sort(
                      (a, b) =>
                        Number(b.status === "online") - Number(a.status === "online") ||
                        a.name.localeCompare(b.name),
                    )
                    .map((node) => (
                      <Command.Item
                        key={node.id}
                        value={`${node.name} ${node.addr ?? ""} ${node.id}`}
                        onSelect={() => pick(node.id)}
                      >
                        <span className={`scope-node-dot scope-${node.status}`} />
                        <span className="min-w-0 flex-1">
                          <strong>{node.name}</strong>
                          <small>
                            {node.status === "online"
                              ? "在线"
                              : node.status === "revoked"
                                ? "已吊销"
                                : "离线"}{" "}
                            · {node.mappingCount} 项服务
                          </small>
                        </span>
                        {value === node.id ? (
                          <Check className="size-4 shrink-0" aria-label="当前范围" />
                        ) : null}
                      </Command.Item>
                    ))}
                </Command.Group>
              )}
            </Command.List>
            <p className="observation-scope-footer">↑ ↓ 选择 · 回车应用 · Esc 关闭</p>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

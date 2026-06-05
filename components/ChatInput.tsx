"use client";

import React, { useRef, useState, useCallback, useEffect, useLayoutEffect, useImperativeHandle, forwardRef, KeyboardEvent } from "react";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface SkillOption {
  name: string;
  description: string;
  source?: "global" | "project" | "path";
  sourceInfo?: {
    source?: string;
    scope?: string;
  };
  disableModelInvocation?: boolean;
}

interface RoleSetting { id: string; text: string; createdAt: string }
interface AgentRole {
  id: string;
  name: string;
  description: string;
  basePrompt: string;
  blocks: Record<string, RoleSetting[]>;
  builtIn?: boolean;
  sourceInfo?: { scope?: string; filePath?: string };
}

interface Props {
  onSend: (message: string, images?: AttachedImage[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  onModelChange?: (provider: string, modelId: string) => void;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  lastModelError?: string | null;
  onClearModelError?: () => void;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  cwd?: string | null;
  currentRoleId?: string;
  onRoleChange?: (roleId: string) => void;
  onRolesLoaded?: (roles: AgentRole[]) => void;
  onOpenRoleConfig?: () => void;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  addImages: (files: File[]) => void;
}

const TOOL_PRESETS = ["off", "default", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "default" | "full", "none" | "default" | "full"> = { off: "none", default: "default", full: "full" };

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh"] as const;
const THINKING_LEVEL_DESC: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "沿用 pi 默认设置",
  off: "关闭推理",
  minimal: "最少推理",
  low: "低强度推理",
  medium: "中等推理",
  high: "高强度推理",
  xhigh: "最高强度推理",
};

function skillScope(skill: SkillOption): "global" | "project" | "path" {
  if (skill.source) return skill.source;
  const scope = skill.sourceInfo?.scope;
  if (scope === "user") return "global";
  if (scope === "project") return "project";
  return "path";
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, modelNames, modelList, onModelChange,
  onCompact, onAbortCompaction, isCompacting, compactError, lastModelError, onClearModelError, toolPreset, onToolPresetChange,
  thinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo,
  soundEnabled, onSoundToggle,
  cwd,
  currentRoleId = "default",
  onRoleChange,
  onRolesLoaded,
  onOpenRoleConfig,
}: Props, ref) {
  const [value, setValue] = useState("");
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [roleDropdownOpen, setRoleDropdownOpen] = useState(false);
  const [roleDropdownRect, setRoleDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [roles, setRoles] = useState<AgentRole[]>([]);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>([]);
  const [isFocused, setIsFocused] = useState(false);

  // Skill picker state
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skills, setSkills] = useState<SkillOption[]>([]);
  const [skillPickerRect, setSkillPickerRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [skillPickerIndex, setSkillPickerIndex] = useState(0);
  const [selectedSkill, setSelectedSkill] = useState<SkillOption | null>(null);
  const skillPickerIndexRef = useRef(0);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const skillsFetchRef = useRef<AbortController | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedSkillChipRef = useRef<HTMLSpanElement>(null);
  const [selectedSkillIndent, setSelectedSkillIndent] = useState(0);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const roleDropdownRef = useRef<HTMLDivElement>(null);
  const roleDropdownPanelRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Track IME composition state to prevent Enter from firing send during Chinese/Japanese/Korean input.
  const isComposingRef = useRef(false);
  const suppressNextEnterRef = useRef(false);
  const suppressNextEnterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingEnterSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCompositionEndAtRef = useRef(0);
  // Sync isStreaming prop to a ref to avoid stale closure in handleSend / runSendAction.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      setValue(text);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      setValue(newVal);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addImages(files: File[]) {
      processImageFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imageFiles.length) return;
    const newImages = await Promise.all(
      imageFiles.map(
        (file) =>
          new Promise<AttachedImage>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              const result = reader.result as string;
              // result is "data:<mime>;base64,<data>"
              const base64 = result.split(",")[1];
              resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
          })
      )
    );
    setAttachedImages((prev) => [...prev, ...newImages]);
  }, []);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      URL.revokeObjectURL(next[index].previewUrl);
      next.splice(index, 1);
      return next;
    });
  }, []);

  const clearImages = useCallback(() => {
    setAttachedImages((prev) => {
      prev.forEach((img) => URL.revokeObjectURL(img.previewUrl));
      return [];
    });
  }, []);

  const cancelPendingEnterSend = useCallback(() => {
    if (pendingEnterSendTimerRef.current) {
      clearTimeout(pendingEnterSendTimerRef.current);
      pendingEnterSendTimerRef.current = null;
    }
  }, []);

  const handleSend = useCallback(() => {
    cancelPendingEnterSend();
    const shouldBlock = isComposingRef.current || suppressNextEnterRef.current || Date.now() - lastCompositionEndAtRef.current < 80;
    if (shouldBlock) return;

    const currentValue = textareaRef.current?.value ?? value;
    const msg = (selectedSkill ? `/skill:${selectedSkill.name} ${currentValue}` : currentValue).trim();
    if (!msg && !attachedImages.length) return;
    if (isStreamingRef.current) return;
    onSend(msg, attachedImages.length ? attachedImages : undefined);
    setValue("");
    setSelectedSkill(null);
    clearImages();
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [value, selectedSkill, attachedImages, onSend, clearImages, cancelPendingEnterSend]);

  const sendQueued = useCallback((mode: "steer" | "followup") => {
    const msg = (selectedSkill ? `/skill:${selectedSkill.name} ${value}` : value).trim();
    if (!msg && !attachedImages.length) return;
    if (mode === "steer" && onSteer) {
      onSteer(msg, attachedImages.length ? attachedImages : undefined);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(msg, attachedImages.length ? attachedImages : undefined);
    }
    setValue("");
    setSelectedSkill(null);
    clearImages();
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, selectedSkill, attachedImages, onSteer, onFollowUp, clearImages]);

  const fetchSkills = useCallback(async (cwd: string) => {
    if (skillsFetchRef.current) {
      skillsFetchRef.current.abort();
    }
    const controller = new AbortController();
    skillsFetchRef.current = controller;
    try {
      const res = await fetch(`/api/skills?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.skills) return;
      setSkills(
        data.skills
          .filter((s: SkillOption) => !s.name?.startsWith("find-skills"))
          .map((s: SkillOption) => ({
            ...s,
            source: skillScope(s),
          }))
      );
    } catch {
      // ignore abort or fetch errors
    }
  }, []);

  const setActiveSkillPickerIndex = useCallback((index: number) => {
    skillPickerIndexRef.current = index;
    setSkillPickerIndex(index);
  }, []);

  const closeSkillPicker = useCallback(() => {
    setSkillPickerOpen(false);
    setActiveSkillPickerIndex(0);
  }, [setActiveSkillPickerIndex]);

  const selectSkill = useCallback((skill: SkillOption) => {
    const ta = textareaRef.current;
    const currentValue = ta?.value ?? value;
    const firstSpace = currentValue.indexOf(" ");
    const rest = currentValue.startsWith("/") && firstSpace >= 0 ? currentValue.slice(firstSpace + 1) : "";
    setSelectedSkill(skill);
    setValue(rest);
    closeSkillPicker();
    requestAnimationFrame(() => {
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(rest.length, rest.length);
    });
  }, [value, closeSkillPicker]);

  const handleTextChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    cancelPendingEnterSend();
    const newValue = e.target.value;
    setValue(newValue);
    if (selectedSkill && newValue.startsWith("/")) setSelectedSkill(null);

    // Skill picker: open when value starts with /
    if (cwd && !selectedSkill && newValue.startsWith("/") && !newValue.includes(" ") && !newValue.startsWith("/skill:")) {
      const ta = textareaRef.current;
      if (ta) {
        const rect = ta.getBoundingClientRect();
        setSkillPickerRect({ top: rect.top, left: rect.left, width: rect.width });
      }
      if (!skillPickerOpen) {
        fetchSkills(cwd);
        setSkillPickerOpen(true);
      }
      setActiveSkillPickerIndex(0);
    } else {
      if (skillPickerOpen) closeSkillPicker();
    }
  }, [cancelPendingEnterSend, skillPickerOpen, selectedSkill, cwd, fetchSkills, closeSkillPicker, setActiveSkillPickerIndex]);

  const handleCompositionStart = useCallback(() => {
    cancelPendingEnterSend();
    if (suppressNextEnterTimerRef.current) {
      clearTimeout(suppressNextEnterTimerRef.current);
      suppressNextEnterTimerRef.current = null;
    }
    isComposingRef.current = true;
    suppressNextEnterRef.current = true;
  }, [cancelPendingEnterSend]);

  const handleCompositionUpdate = useCallback(() => {
    cancelPendingEnterSend();
    isComposingRef.current = true;
    suppressNextEnterRef.current = true;
  }, [cancelPendingEnterSend]);

  const handleCompositionEnd = useCallback(() => {
    cancelPendingEnterSend();
    isComposingRef.current = false;
    suppressNextEnterRef.current = true;
    lastCompositionEndAtRef.current = Date.now();

    if (suppressNextEnterTimerRef.current) {
      clearTimeout(suppressNextEnterTimerRef.current);
    }
    suppressNextEnterTimerRef.current = setTimeout(() => {
      suppressNextEnterRef.current = false;
      suppressNextEnterTimerRef.current = null;
    }, 80);
  }, [cancelPendingEnterSend]);

  const runSendAction = useCallback(() => {
    if (isStreamingRef.current && (onSteer || onFollowUp)) {
      sendQueued(onSteer ? "steer" : "followup");
    } else {
      handleSend();
    }
  }, [onSteer, onFollowUp, sendQueued, handleSend]);

  const scheduleEnterSend = useCallback(() => {
    cancelPendingEnterSend();
    pendingEnterSendTimerRef.current = setTimeout(() => {
      pendingEnterSendTimerRef.current = null;
      const shouldBlock = isComposingRef.current || suppressNextEnterRef.current || Date.now() - lastCompositionEndAtRef.current < 80;
      if (shouldBlock) return;
      runSendAction();
    }, 80);
  }, [cancelPendingEnterSend, runSendAction]);

  // Filtered skills for the picker
  const skillPickerFilter = (() => {
    if (!value.startsWith("/") || value.startsWith("/skill:")) return "";
    return value.slice(1).toLowerCase();
  })();

  const filteredSkills = (() => {
    if (!skillPickerFilter) return skills;
    const q = skillPickerFilter;
    return skills.filter(
      (s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    );
  })();

  const globalSkills = filteredSkills.filter((s) => skillScope(s) === "global");
  const projectSkills = filteredSkills.filter((s) => skillScope(s) === "project");
  const visibleSkillPickerSkills = [...globalSkills, ...projectSkills];
  const commonProjectSkills = skills
    .filter((s) => skillScope(s) === "project" && !s.disableModelInvocation)
    .slice(0, 8);

  useEffect(() => {
    if (!cwd) {
      setSkills([]);
      return;
    }
    fetchSkills(cwd);
    return () => {
      skillsFetchRef.current?.abort();
    };
  }, [cwd, fetchSkills]);

  // Reset skill picker index when filter changes
  useEffect(() => {
    setActiveSkillPickerIndex(0);
  }, [skillPickerFilter, setActiveSkillPickerIndex]);

  const handleSkillPickerKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (visibleSkillPickerSkills.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveSkillPickerIndex(Math.min(skillPickerIndexRef.current + 1, visibleSkillPickerSkills.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveSkillPickerIndex(Math.max(skillPickerIndexRef.current - 1, 0));
      return;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      const activeIndex = Math.min(skillPickerIndexRef.current, visibleSkillPickerSkills.length - 1);
      if (visibleSkillPickerSkills[activeIndex]) {
        selectSkill(visibleSkillPickerSkills[activeIndex]);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSkillPicker();
      return;
    }
    // Let other keys pass through for normal typing
  }, [visibleSkillPickerSkills, setActiveSkillPickerIndex, selectSkill, closeSkillPicker]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Handle skill picker keys first
      if (skillPickerOpen) {
        handleSkillPickerKeyDown(e);
        return;
      }

      if (selectedSkill && (e.key === "Backspace" || e.key === "Delete")) {
        const ta = e.currentTarget;
        const start = ta.selectionStart ?? 0;
        const end = ta.selectionEnd ?? 0;
        const isEmpty = ta.value.length === 0;
        const isBackspaceAtStart = e.key === "Backspace" && start === 0 && end === 0;
        const isDeleteAtStart = e.key === "Delete" && start === 0 && end === 0;
        if (isEmpty || isBackspaceAtStart || isDeleteAtStart) {
          e.preventDefault();
          setSelectedSkill(null);
          return;
        }
      }

      const nativeEvent = e.nativeEvent as KeyboardEvent<HTMLTextAreaElement>["nativeEvent"] & {
        keyCode?: number;
        which?: number;
      };
      const isImeEvent =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229 ||
        nativeEvent.which === 229 ||
        e.key === "Process";
      const isImmediatelyAfterComposition = Date.now() - lastCompositionEndAtRef.current < 80;

      if (isImeEvent) {
        suppressNextEnterRef.current = true;
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();

        if (suppressNextEnterRef.current || isImmediatelyAfterComposition) {
          cancelPendingEnterSend();
          suppressNextEnterRef.current = false;
          if (suppressNextEnterTimerRef.current) {
            clearTimeout(suppressNextEnterTimerRef.current);
            suppressNextEnterTimerRef.current = null;
          }
          return;
        }

        scheduleEnterSend();
      } else if (e.key !== "Shift") {
        cancelPendingEnterSend();
        suppressNextEnterRef.current = false;
        if (suppressNextEnterTimerRef.current) {
          clearTimeout(suppressNextEnterTimerRef.current);
          suppressNextEnterTimerRef.current = null;
        }
      }
    },
    [cancelPendingEnterSend, scheduleEnterSend, skillPickerOpen, handleSkillPickerKeyDown]
  );

  const handleInput = useCallback(() => {
    cancelPendingEnterSend();
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [cancelPendingEnterSend]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (!imageItems.length) return;
    e.preventDefault();
    const files = imageItems.map((item) => item.getAsFile()).filter((f): f is File => f !== null);
    processImageFiles(files);
  }, [processImageFiles]);



  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name }));
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  })();

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of modelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  const currentName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : modelOptions.length > 0 ? modelOptions[0].name : null;

  // Keep the textarea's first line indented by the visual skill chip.
  // The textarea itself stays full-width, so wrapped/new lines can flow underneath the chip.
  useLayoutEffect(() => {
    if (!selectedSkill) {
      setSelectedSkillIndent(0);
      return;
    }

    const chip = selectedSkillChipRef.current;
    const measure = () => {
      setSelectedSkillIndent(chip ? Math.ceil(chip.getBoundingClientRect().width) + 8 : 0);
    };

    measure();
    const resizeObserver = chip && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (chip) resizeObserver?.observe(chip);
    window.addEventListener("resize", measure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [selectedSkill]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
      if (
        roleDropdownRef.current && !roleDropdownRef.current.contains(e.target as Node) &&
        roleDropdownPanelRef.current && !roleDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setRoleDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (skillPickerRef.current && !skillPickerRef.current.contains(e.target as Node)) {
        setSkillPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const loadRoles = useCallback(async () => {
    try {
      const url = cwd ? `/api/roles?cwd=${encodeURIComponent(cwd)}` : "/api/roles";
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json() as { roles: AgentRole[] };
      setRoles(data.roles ?? []);
      onRolesLoaded?.(data.roles ?? []);
    } catch { /* ignore */ }
  }, [onRolesLoaded, cwd]);

  useEffect(() => {
    loadRoles();
    const handler = () => loadRoles();
    window.addEventListener("pi-agent.roles-updated", handler);
    return () => window.removeEventListener("pi-agent.roles-updated", handler);
  }, [loadRoles]);

  const selectedRole = roles.find((r) => r.id === currentRoleId) ?? roles.find((r) => r.id === "default");
  const roleSettingCount = selectedRole ? Object.values(selectedRole.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0) : 0;



  return (
    <div
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
        paddingRight: 52, // 16px base + 36px for ChatMinimap alignment
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          processImageFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(234,179,8,0.08)", border: "1px solid rgba(234,179,8,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(180,130,0,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
            正在重试 ({retryInfo.attempt}/{retryInfo.maxAttempts})…{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {/* Model error banner */}
        {lastModelError && !retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.25)",
            borderRadius: 6, fontSize: 12, color: "rgba(200,60,60,0.9)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              模型调用失败{lastModelError ? `：${lastModelError}` : ""}
            </span>
            {onClearModelError && (
              <button
                onClick={onClearModelError}
                style={{
                  flexShrink: 0,
                  background: "none", border: "none", cursor: "pointer",
                  padding: "1px 4px", color: "inherit", opacity: 0.6,
                  fontSize: 11, lineHeight: 1,
                }}
              >
                ✕
              </button>
            )}
          </div>
        )}
        {/* Image previews */}
        {attachedImages.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap" }}>
            {attachedImages.map((img, i) => (
              <div key={i} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Skill picker dropdown */}
        {skillPickerOpen && skillPickerRect && (() => {
          const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
          const totalSkills = visibleSkillPickerSkills.length;
          if (totalSkills === 0) return null;
          const bottom = viewportHeight - skillPickerRect.top + 6;
          const maxH = Math.max(120, Math.min(skillPickerRect.top - 8, viewportHeight * 0.5));
          return (
            <div ref={skillPickerRef} style={{
              position: "fixed",
              bottom, left: skillPickerRect.left,
              zIndex: 501, background: "var(--bg)", border: "1px solid var(--border)",
              borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.12)",
              overflow: "hidden", width: "max-content", minWidth: Math.max(skillPickerRect.width, 320), maxWidth: 480,
              maxHeight: maxH, overflowY: "auto",
            }}>
              <div style={{ padding: "5px 12px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>
                选择技能（使用 ↑↓ 导航，Enter 选择，Esc 关闭）
              </div>
              {globalSkills.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: "1px solid var(--border)" }}>
                    全局技能
                  </div>
                  {globalSkills.map((skill, gi) => {
                    const absIdx = gi;
                    const isActive = absIdx === skillPickerIndex;
                    return (
                      <button
                        key={skill.name}
                        onClick={() => selectSkill(skill)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: isActive ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: isActive ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: isActive ? 500 : 400,
                          lineHeight: 1.5,
                        }}
                        onMouseEnter={(e) => { setSkillPickerIndex(absIdx); e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                      >
                        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", minWidth: "fit-content" }}>
                          /skill:{skill.name}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {skill.description}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
              {projectSkills.length > 0 && (
                <>
                  <div style={{ padding: "4px 12px 2px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.05em", borderTop: "1px solid var(--border)" }}>
                    项目技能
                  </div>
                  {projectSkills.map((skill, pi) => {
                    const absIdx = globalSkills.length + pi;
                    const isActive = absIdx === skillPickerIndex;
                    return (
                      <button
                        key={skill.name}
                        onClick={() => selectSkill(skill)}
                        style={{
                          display: "flex", alignItems: "flex-start", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: isActive ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: isActive ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: isActive ? 500 : 400,
                          lineHeight: 1.5,
                        }}
                        onMouseEnter={(e) => { setSkillPickerIndex(absIdx); e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                      >
                        <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--accent)", minWidth: "fit-content" }}>
                          /skill:{skill.name}
                        </span>
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {skill.description}
                        </span>
                      </button>
                    );
                  })}
                </>
              )}
            </div>
          );
        })()}

        {/* Common project skill shortcuts */}
        {isFocused && commonProjectSkills.length > 0 && !selectedSkill && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              marginBottom: 6,
              overflowX: "auto",
              padding: "0 1px 2px",
              scrollbarWidth: "none",
            }}
          >
            <span
              style={{
                flexShrink: 0,
                fontSize: 11,
                color: "var(--text-dim)",
                marginRight: 2,
              }}
            >
              项目技能
            </span>
            {commonProjectSkills.map((skill) => (
              <button
                key={skill.name}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  selectSkill(skill);
                }}
                title={skill.description ? `${skill.name} — ${skill.description}` : skill.name}
                style={{
                  flexShrink: 0,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  maxWidth: 180,
                  height: 26,
                  padding: "0 9px",
                  borderRadius: 999,
                  border: "1px solid color-mix(in srgb, var(--accent) 16%, var(--border))",
                  background: "color-mix(in srgb, var(--accent) 5%, var(--bg))",
                  color: "color-mix(in srgb, var(--accent) 60%, var(--text-muted))",
                  cursor: "pointer",
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 10%, var(--bg-hover))";
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 28%, var(--border))";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "color-mix(in srgb, var(--accent) 5%, var(--bg))";
                  e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 16%, var(--border))";
                }}
              >
                <span aria-hidden="true" style={{ opacity: 0.72 }}>✦</span>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {skill.name}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Main input */}
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            background: "var(--bg)",
            border: `1px solid ${isStreaming && (onSteer || onFollowUp)
              ? "rgba(234,179,8,0.4)"
              : "color-mix(in srgb, var(--border) 70%, transparent)"}`,
            borderRadius: 14,
            padding: "10px 10px 10px 14px",
            boxShadow: "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
            transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
          } as React.CSSProperties}
        >
          <div
            style={{
              position: "relative",
              flex: 1,
              minWidth: 0,
              alignSelf: "center",
              display: "flex",
              alignItems: "center",
            }}
          >
            {selectedSkill && (
              <span
                ref={selectedSkillChipRef}
                title={`当前启用 skill: ${selectedSkill.name}`}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  zIndex: 1,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  maxWidth: 200,
                  height: 22,
                  padding: "0 5px 0 7px",
                  borderRadius: 999,
                  background: "color-mix(in srgb, var(--accent) 6%, var(--bg))",
                  border: "1px solid color-mix(in srgb, var(--accent) 13%, transparent)",
                  color: "color-mix(in srgb, var(--accent) 55%, var(--text-muted))",
                  fontSize: 12,
                  fontWeight: 500,
                  letterSpacing: "-0.01em",
                  backdropFilter: "blur(8px)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.10), 0 1px 2px rgba(15,23,42,0.03)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "currentColor",
                    opacity: 0.45,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {selectedSkill.name}
                </span>
                <button
                  type="button"
                  onClick={() => { setSelectedSkill(null); textareaRef.current?.focus(); }}
                  aria-label={`移除 skill ${selectedSkill.name}`}
                  title="移除技能"
                  style={{
                    flexShrink: 0,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 14,
                    height: 14,
                    marginRight: -2,
                    border: "none",
                    borderRadius: "50%",
                    background: "transparent",
                    color: "inherit",
                    cursor: "pointer",
                    padding: 0,
                    opacity: 0.42,
                    outline: "none",
                    transition: "background 120ms ease, opacity 120ms ease, color 120ms ease",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = "color-mix(in srgb, currentColor 9%, transparent)"; e.currentTarget.style.opacity = "0.85"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.opacity = "0.42"; }}
                  onFocus={(e) => { e.currentTarget.style.background = "color-mix(in srgb, currentColor 9%, transparent)"; e.currentTarget.style.opacity = "0.9"; }}
                  onBlur={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.opacity = "0.42"; }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                    <path d="M18 6 6 18" />
                    <path d="m6 6 12 12" />
                  </svg>
                </button>
              </span>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={handleTextChange}
              onKeyDown={handleKeyDown}
              onInput={handleInput}
              onPaste={handlePaste}
              onCompositionStart={handleCompositionStart}
              onCompositionUpdate={handleCompositionUpdate}
              onCompositionEnd={handleCompositionEnd}
              onFocus={() => setIsFocused(true)}
              onBlur={() => {
                setIsFocused(false);
                // Delay close so click on skill picker item can fire first
                setTimeout(() => setSkillPickerOpen(false), 150);
              }}
              placeholder={
                isStreaming && (onSteer || onFollowUp)
                  ? "Steer 立即注入 / Follow-up 排队…"
                  : isStreaming ? "智能体正在运行…"
                  : "输入消息…"
              }
              rows={2}
              style={{
                width: "100%",
                background: "none",
                border: "none",
                outline: "none",
                resize: "none",
                color: "var(--text)",
                fontSize: 14,
                lineHeight: "22px",
                fontFamily: "inherit",
                padding: 0,
                paddingLeft: selectedSkillIndent,
                margin: 0,
                display: "block",
                boxSizing: "border-box",
                minHeight: 44,
                maxHeight: 200,
                overflow: "auto",
                textIndent: 0,
              }}
            />
          </div>

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
              {onSteer && (
                <button
                  type="button"
                  onClick={() => sendQueued("steer")}
                  disabled={!value.trim() && !attachedImages.length && !selectedSkill}
                  title="打断 Agent 当前运行，立即注入消息"
                  aria-label="立即注入消息"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28,
                    height: 28,
                    padding: 0,
                    background: (value.trim() || attachedImages.length || selectedSkill) ? "var(--bg-panel)" : "var(--bg-panel)",
                    border: "none",
                    borderRadius: "50%",
                    color: (value.trim() || attachedImages.length || selectedSkill) ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: (value.trim() || attachedImages.length || selectedSkill) ? "pointer" : "not-allowed",
                    boxShadow: "none",
                    transition: "background 0.15s, box-shadow 0.15s",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                </button>
              )}
              {onFollowUp && (
                <button
                  type="button"
                  onClick={() => sendQueued("followup")}
                  disabled={!value.trim() && !attachedImages.length && !selectedSkill}
                  title="在 Agent 完成后排队发送"
                  aria-label="排队发送消息"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 28,
                    height: 28,
                    padding: 0,
                    background: (value.trim() || attachedImages.length || selectedSkill) ? "var(--bg-panel)" : "var(--bg-panel)",
                    border: "none",
                    borderRadius: "50%",
                    color: (value.trim() || attachedImages.length || selectedSkill) ? "var(--text-muted)" : "var(--text-dim)",
                    cursor: (value.trim() || attachedImages.length || selectedSkill) ? "pointer" : "not-allowed",
                    boxShadow: "none",
                    transition: "background 0.15s, box-shadow 0.15s",
                  }}
                >
                  <svg width="14" height="14" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                onClick={onAbort}
                title="停止 Agent"
                aria-label="停止 Agent"
                style={{
                  flexShrink: 0,
                  alignSelf: "flex-end",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 28,
                  height: 28,
                  padding: 0,
                  background: "#ef4444",
                  border: "none",
                  borderRadius: "50%",
                  color: "#fff",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  letterSpacing: "-0.01em",
                  boxShadow: "0 1px 3px rgba(239,68,68,0.25)",
                  transition: "background 0.15s, box-shadow 0.15s",
                }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              disabled={!value.trim() && !attachedImages.length && !selectedSkill}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 28,
                height: 28,
                padding: 0,
                background: (value.trim() || attachedImages.length || selectedSkill) ? "var(--accent)" : "var(--bg-panel)",
                border: "none",
                borderRadius: "50%",
                color: (value.trim() || attachedImages.length || selectedSkill) ? "#fff" : "var(--text-dim)",
                cursor: (value.trim() || attachedImages.length || selectedSkill) ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                boxShadow: (value.trim() || attachedImages.length || selectedSkill) ? "0 1px 3px rgba(37,99,235,0.25)" : "none",
                transition: "background 0.15s, box-shadow 0.15s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Bottom bar: left | center (context) | right */}
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6 }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2 }}>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              title="附加图片"
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: 9,
                color: attachedImages.length ? "var(--accent)" : "var(--text-muted)",
                cursor: isStreaming ? "not-allowed" : "pointer",
                opacity: isStreaming ? 0.5 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                if (isStreaming) return;
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* Role selector */}
            {selectedRole && onRoleChange && (
              <div ref={roleDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={(e) => {
                    if (isStreaming) return;
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setRoleDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                    setRoleDropdownOpen((v) => !v);
                  }}
                  disabled={isStreaming}
                  title={roleSettingCount ? `当前角色有 ${roleSettingCount} 条设定` : "选择角色"}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 12px", height: 32, maxWidth: 180,
                    background: roleDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none", borderRadius: 9,
                    color: roleSettingCount ? "var(--accent)" : "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => { if (!isStreaming) { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; } }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = roleDropdownOpen ? "var(--bg-hover)" : "none"; e.currentTarget.style.color = roleSettingCount ? "var(--accent)" : "var(--text-muted)"; }}
                >
                  <span style={{ fontWeight: 600 }}>@</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedRole.name}</span>
                </button>
                {roleDropdownOpen && roleDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const bottom = viewportHeight - roleDropdownRect.top + 6;
                  const maxH = Math.max(120, Math.min(roleDropdownRect.top - 8, viewportHeight * 0.6));
                  return (
                  <div ref={roleDropdownPanelRef} style={{
                    position: "fixed", bottom, left: roleDropdownRect.left,
                    zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", width: "max-content", minWidth: Math.max(roleDropdownRect.width, 260), maxHeight: maxH, overflowY: "auto",
                  }}>
                    <div style={{ padding: "6px 12px 4px", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>角色</div>
                    {roles.map((role) => {
                      const active = role.id === selectedRole.id;
                      const count = Object.values(role.blocks ?? {}).reduce((n, arr) => n + (arr?.length ?? 0), 0);
                      const scope = role.sourceInfo?.scope ?? (role.builtIn ? "builtIn" : "user");
                      const scopeText = scope === "project" ? "项目" : scope === "user" ? "全局" : scope === "builtIn" ? "内置" : scope;
                      return <button
                        key={role.id}
                        onClick={() => { onRoleChange(role.id); setRoleDropdownOpen(false); }}
                        style={{
                          display: "flex", alignItems: "center", gap: 8,
                          width: "100%", padding: "7px 12px",
                          background: active ? "var(--bg-selected)" : "none",
                          border: "none",
                          color: active ? "var(--text)" : "var(--text-muted)",
                          cursor: "pointer", fontSize: 12, textAlign: "left",
                          fontWeight: active ? 600 : 400,
                          whiteSpace: "nowrap",
                        }}
                        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "var(--bg-hover)"; }}
                        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "none"; }}
                      >
                        {active ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg> : <span style={{ width: 10 }} />}
                        <span style={{ flex: 1 }}>{role.name}</span>
                        <span style={{ fontSize: 10, color: scope === "project" ? "var(--accent)" : "var(--text-dim)" }}>{scopeText}</span>
                        {count > 0 && <span style={{ fontSize: 10, color: "var(--text-dim)" }}>{count} 条</span>}
                      </button>;
                    })}
                    <div style={{ borderTop: "1px solid var(--border)", padding: 0 }}>
                      <button
                        onClick={() => { setRoleDropdownOpen(false); onOpenRoleConfig?.(); }}
                        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "7px 12px", background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12, textAlign: "left", whiteSpace: "nowrap" }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; e.currentTarget.style.color = "var(--text)"; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = "none"; e.currentTarget.style.color = "var(--text-muted)"; }}
                      >
                        <span style={{ width: 10, textAlign: "center" }}>＋</span>
                        <span style={{ flex: 1 }}>创建 / 管理角色</span>
                      </button>
                    </div>
                  </div>
                  );
                })()}
              </div>
            )}
            {/* Model selector — visible always, disabled during streaming */}
            {modelOptions.length > 0 && currentName && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative" }}>
                  <button
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, left: rect.left, width: rect.width });
                      setModelDropdownOpen((v) => !v);
                    }}
                    disabled={isStreaming}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "8px 12px",
                      height: 32,
                      maxWidth: 220, overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: 9,
                      color: "var(--text-muted)",
                      cursor: isStreaming ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="4" y="4" width="16" height="16" rx="2" />
                      <rect x="9" y="9" width="6" height="6" />
                      <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                      <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                      <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                      <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                    </svg>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{currentName}</span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    const bottom = viewportHeight - modelDropdownRect.top + 6;
                    const maxH = Math.max(120, Math.min(modelDropdownRect.top - 8, viewportHeight * 0.6));
                    return (
                    <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      bottom, left: modelDropdownRect.left,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                      overflow: "hidden", width: "max-content", minWidth: modelDropdownRect.width, maxHeight: maxH, overflowY: "auto",
                    }}>
                      {modelsByProvider.map((group, gi) => (
                        <div key={group.provider}>
                          {(modelsByProvider.length > 1) && (
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                            }}>
                              {group.provider}
                            </div>
                          )}
                          {group.options.map((opt) => {
                            const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                            return (
                              <button
                                key={`${opt.provider}:${opt.modelId}`}
                                onClick={() => { setModelDropdownOpen(false); if (!isActive) onModelChange(opt.provider, opt.modelId); }}
                                style={{
                                  display: "flex", alignItems: "center", gap: 8,
                                  width: "100%", padding: "7px 12px",
                                  background: isActive ? "var(--bg-selected)" : "none",
                                  border: "none",
                                  color: isActive ? "var(--text)" : "var(--text-muted)",
                                  cursor: "pointer", fontSize: 12, textAlign: "left",
                                  fontWeight: isActive ? 600 : 400,
                                  whiteSpace: "nowrap",
                                }}
                                onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                              >
                                {isActive
                                  ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                  : <span style={{ width: 10, flexShrink: 0 }} />}
                                {opt.name}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                    );
                  })()}
                </div>
            )}
          </div>

          {/* spacer */}
          <div style={{ flex: 1 }} />

          {/* RIGHT: thinking + tools preset + compact + sound */}
          <div style={{ flex: "0 0 auto", display: "flex", alignItems: "center", gap: 2, marginLeft: "auto" }}>
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title="切换推理强度"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span>{(() => {
                    const lvl = thinkingLevel ?? "auto";
                    if (lvl === "auto" || !thinkingLevelMap) return lvl;
                    const mapped = thinkingLevelMap[lvl];
                    return mapped != null ? mapped : lvl;
                  })()}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                      const desc = THINKING_LEVEL_DESC[lvl];
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); if (!isActive) onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                  title="切换工具预设"
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span>{Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default"}</span>
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: 8, boxShadow: "0 -4px 16px rgba(0,0,0,0.10)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = (toolPreset ?? "default") === preset;
                      const desc = lvl === "off" ? "无工具，纯聊天" : lvl === "default" ? "4 项内置工具" : "全部内置工具";
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isStreaming && onCompact && (
              <div style={{ position: "relative" }}>
                {compactError && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    background: "#1f2937", color: "#f87171",
                    fontSize: 11, padding: "4px 8px", borderRadius: 5,
                    whiteSpace: "nowrap", pointerEvents: "none",
                    boxShadow: "0 2px 8px rgba(0,0,0,0.2)", zIndex: 50,
                  }}>
                    {compactError}
                  </div>
                )}
                <button
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: isCompacting ? "rgba(239,68,68,0.08)" : "none",
                    border: "none",
                    borderRadius: 9,
                    color: isCompacting ? "#ef4444" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.16)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "rgba(239,68,68,0.08)" : "none";
                    e.currentTarget.style.color = isCompacting ? "#ef4444" : "var(--text-muted)";
                  }}
                  title={isCompacting ? "停止压缩" : "压缩上下文"}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg>压缩中…</>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg>压缩</>
                  )}
                </button>
              </div>
            )}

            {onSoundToggle !== undefined && (
              <button
                onClick={onSoundToggle}
                title={soundEnabled ? "关闭完成提示音" : "开启完成提示音"}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 32, height: 32, padding: 0,
                  background: "none",
                  border: "none",
                  borderRadius: 9,
                  color: soundEnabled ? "var(--text-muted)" : "var(--text-dim)",
                  cursor: "pointer",
                  opacity: soundEnabled ? 1 : 0.55,
                  transition: "background 0.12s, color 0.12s, opacity 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                  e.currentTarget.style.color = "var(--text)";
                  e.currentTarget.style.opacity = "1";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "none";
                  e.currentTarget.style.color = soundEnabled ? "var(--text-muted)" : "var(--text-dim)";
                  e.currentTarget.style.opacity = soundEnabled ? "1" : "0.55";
                }}
              >
                {soundEnabled ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </svg>
                )}
              </button>
            )}
          </div>

        </div>
      </div>
    </div>
  );
});

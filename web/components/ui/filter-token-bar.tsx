"use client";

// Upstream component relies on positional ref registration during render and
// effect-driven popover state; the React Compiler lint rules flag both.
/* eslint-disable react-hooks/refs, react-hooks/set-state-in-effect */

import * as React from "react";
import {
  AnimatePresence,
  motion,
  useReducedMotion,
  type Transition,
} from "framer-motion";
import { createPortal } from "react-dom";

export interface FilterOption {
  value: string;
  label: string;

  glyph?: React.ReactNode;
}

export interface FilterOperatorDef {
  value: string;
  label: string;

  multi?: boolean;
}

export interface FilterFieldDef {
  id: string;
  label: string;

  icon?: React.ReactNode;
  operators: FilterOperatorDef[];

  options?: FilterOption[];

  loadOptions?: (query: string) => Promise<FilterOption[]>;
}

export interface Filter {
  id: string;
  field: string;
  operator: string;
  values: string[];
}

export interface FilterBarProps {
  fields: FilterFieldDef[];
  value: Filter[];
  onChange: (filters: Filter[]) => void;

  addLabel?: string;

  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `f_${Math.random().toString(36).slice(2, 9)}`;

const springy: Transition = { type: "spring", stiffness: 560, damping: 34, mass: 0.7 };

function fieldById(fields: FilterFieldDef[], id: string) {
  return fields.find((f) => f.id === id);
}

function operatorByValue(field: FilterFieldDef | undefined, value: string) {
  return field?.operators.find((o) => o.value === value);
}

function summarize(
  options: FilterOption[] | undefined,
  values: string[]
): { text: string; empty: boolean; glyphs: React.ReactNode[] } {
  if (!values.length) return { text: "Select…", empty: true, glyphs: [] };
  const find = (v: string) => options?.find((o) => o.value === v);
  const label = (v: string) => find(v)?.label ?? v;

  const glyphs = values
    .map((v) => find(v)?.glyph)
    .filter(Boolean)
    .slice(0, 3) as React.ReactNode[];
  if (values.length === 1) return { text: label(values[0]), empty: false, glyphs };
  if (values.length <= 3)
    return { text: values.map(label).join(", "), empty: false, glyphs };
  return {
    text: `${label(values[0])} +${values.length - 1}`,
    empty: false,
    glyphs,
  };
}

interface PopoverProps {
  anchorKey: string;
  onClose: () => void;
  children: React.ReactNode;
  labelledBy?: string;
}

function Popover({ anchorKey, onClose, children, labelledBy }: PopoverProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const [anchor, setAnchor] = React.useState<HTMLElement | null>(null);

  const [dark, setDark] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(
    null
  );

  React.useLayoutEffect(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-fb-anchor="${anchorKey}"]`
    );
    setAnchor(el);
    setDark(!!el?.closest(".dark"));
  }, [anchorKey]);

  const keyRef = React.useRef(anchorKey);
  keyRef.current = anchorKey;
  React.useEffect(
    () => () => {
      document
        .querySelector<HTMLElement>(`[data-fb-anchor="${keyRef.current}"]`)
        ?.focus();
    },
    []
  );

  React.useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const gap = 6;
      let left = a.left;
      let top = a.bottom + gap;
      left = Math.min(left, window.innerWidth - w - 8);
      left = Math.max(8, left);
      if (top + h > window.innerHeight - 8) top = a.top - gap - h;
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  React.useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (
        ref.current &&
        !ref.current.contains(e.target as Node) &&
        !(anchor && anchor.contains(e.target as Node))
      )
        onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  return createPortal(
    <div className={dark ? "dark" : ""} style={{ display: "contents" }}>
      <motion.div
        ref={ref}
        role="dialog"
        aria-labelledby={labelledBy}
        initial={reduce ? false : { opacity: 0, y: -3, scale: 0.985 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.12, ease: [0.2, 0.8, 0.2, 1] }}
        style={{
          position: "fixed",

          top: pos?.top ?? -9999,
          left: pos?.left ?? -9999,
          zIndex: 60,
        }}
        className="min-w-[13rem] max-w-[18rem] overflow-hidden rounded-lg border border-zinc-950/10 bg-white shadow-lg shadow-zinc-950/10 dark:border-white/10 dark:bg-zinc-900 dark:shadow-black/40"
      >
        {children}
      </motion.div>
    </div>,
    document.body
  );
}

interface ListItem {
  value: string;
  label: string;
  glyph?: React.ReactNode;
  selected?: boolean;
}

interface SearchListProps {
  items: ListItem[];
  multi: boolean;
  loading?: boolean;
  error?: boolean;
  searchable?: boolean;
  placeholder?: string;
  onQuery?: (q: string) => void;
  onPick: (value: string) => void;
  onRetry?: () => void;
  labelId: string;
}

function SearchList({
  items,
  multi,
  loading,
  error,
  searchable = true,
  placeholder = "Filter…",
  onQuery,
  onPick,
  onRetry,
  labelId,
}: SearchListProps) {
  const [q, setQ] = React.useState("");
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLUListElement>(null);

  const filtered = React.useMemo(() => {
    if (onQuery) return items;
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) => i.label.toLowerCase().includes(needle));
  }, [items, q, onQuery]);

  React.useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  React.useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  React.useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${active}"]`
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const commit = (i: number) => {
    const item = filtered[i];
    if (item) onPick(item.value);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(filtered.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(active);
    }
  };

  return (
    <div>
      {searchable && (
        <div className="border-b border-zinc-950/8 p-1.5 dark:border-white/8">
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              filtered[active] ? `${listId}-${active}` : undefined
            }
            aria-labelledby={labelId}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              onQuery?.(e.target.value);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            className="w-full bg-transparent px-1.5 py-1 text-[13px] text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      )}

      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-multiselectable={multi || undefined}
        aria-labelledby={labelId}
        className="max-h-60 overflow-y-auto p-1"

        onKeyDown={onKeyDown}
        tabIndex={-1}
      >
        {loading && (
          <li className="flex items-center gap-2 px-2 py-3 text-[13px] text-zinc-500 dark:text-zinc-400">
            <Spinner /> Loading options…
          </li>
        )}

        {error && !loading && (
          <li className="px-2 py-2.5 text-[13px]">
            <p className="text-zinc-600 dark:text-zinc-300">
              Couldn’t load options.
            </p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded-md px-1.5 py-0.5 text-[13px] font-medium text-zinc-900 underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 dark:text-zinc-100 dark:decoration-zinc-600"
            >
              Try again
            </button>
          </li>
        )}

        {!loading && !error && filtered.length === 0 && (
          <li className="px-2 py-3 text-[13px] text-zinc-500 dark:text-zinc-400">
            No matches
          </li>
        )}

        {!loading &&
          !error &&
          filtered.map((item, i) => {
            const isActive = i === active;
            return (
              <li
                key={item.value}
                id={`${listId}-${i}`}
                data-idx={i}
                role="option"
                aria-selected={multi ? !!item.selected : isActive}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(item.value)}
                className={[
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px]",
                  isActive
                    ? "bg-zinc-100 dark:bg-white/10"
                    : "bg-transparent",
                  "text-zinc-800 dark:text-zinc-100",
                ].join(" ")}
              >
                {multi && (
                  <span
                    aria-hidden
                    className={[
                      "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                      item.selected
                        ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                        : "border-zinc-300 dark:border-zinc-600",
                    ].join(" ")}
                  >
                    {item.selected && <CheckIcon />}
                  </span>
                )}
                {item.glyph && (
                  <span className="shrink-0" aria-hidden>
                    {item.glyph}
                  </span>
                )}
                <span className="truncate">{item.label}</span>
                {!multi && item.selected && (
                  <span className="ml-auto text-zinc-500 dark:text-zinc-400">
                    <CheckIcon />
                  </span>
                )}
              </li>
            );
          })}
      </ul>
    </div>
  );
}

interface SegmentProps {
  role: "field" | "operator" | "value";
  children: React.ReactNode;
  onOpen: () => void;
  registerRef: (el: HTMLButtonElement | null) => void;
  tabIndex: number;
  ariaLabel: string;
  anchorKey: string;
  onFocus: () => void;
  muted?: boolean;
  active?: boolean;
  flash?: boolean;
}

const Segment = React.forwardRef<HTMLButtonElement, SegmentProps>(
  function Segment(
    {
      role,
      children,
      onOpen,
      registerRef,
      tabIndex,
      ariaLabel,
      anchorKey,
      onFocus,
      muted,
      active,
      flash,
    },
    _ref
  ) {
    return (
      <button
        type="button"
        ref={registerRef}
        tabIndex={tabIndex}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={active}
        data-fb-anchor={anchorKey}
        onFocus={onFocus}
        onClick={onOpen}
        data-flash={flash ? "" : undefined}
        className={[
          "relative flex items-center gap-1 whitespace-nowrap px-2 py-[4px] text-[13px] leading-[1.35] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70",
          "active:scale-[0.98]",
          muted
            ? "text-zinc-500 dark:text-zinc-400"
            : "text-zinc-800 dark:text-zinc-100",
          active
            ? "bg-zinc-200/70 dark:bg-white/[0.12]"
            : "hover:bg-zinc-200/60 dark:hover:bg-white/[0.08]",
          role === "field" ? "rounded-l-md font-medium" : "",
          role === "value" ? "min-w-0" : "shrink-0",
          "data-[flash]:animate-[fb-flash_620ms_ease-out]",
        ].join(" ")}
      >
        {children}
      </button>
    );
  }
);

type OpenState =
  | { kind: "add" }
  | { kind: "field"; filterId: string }
  | { kind: "operator"; filterId: string }
  | { kind: "value"; filterId: string }
  | null;

export function FilterBar({
  fields,
  value,
  onChange,
  addLabel = "Filter",
  emptyLabel = "Add filter",
  disabled,
  className,
  "aria-label": ariaLabel = "Filters",
}: FilterBarProps) {
  const reduce = useReducedMotion();
  const [open, setOpen] = React.useState<OpenState>(null);
  const [flashId, setFlashId] = React.useState<string | null>(null);

  const itemRefs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const [focusIdx, setFocusIdx] = React.useState(0);

  const [asyncState, setAsyncState] = React.useState<
    Record<string, { loading: boolean; error: boolean; options: FilterOption[] }>
  >({});

  const itemMeta: { filterId?: string; kind: string }[] = [];
  value.forEach((f) => {
    itemMeta.push({ filterId: f.id, kind: "field" });
    itemMeta.push({ filterId: f.id, kind: "operator" });
    itemMeta.push({ filterId: f.id, kind: "value" });
    itemMeta.push({ filterId: f.id, kind: "remove" });
  });
  itemMeta.push({ kind: "add" });

  React.useEffect(() => {
    if (focusIdx > itemMeta.length - 1) setFocusIdx(itemMeta.length - 1);
  }, [itemMeta.length, focusIdx]);

  const focusItem = (idx: number) => {
    const clamped = Math.max(0, Math.min(idx, itemMeta.length - 1));
    setFocusIdx(clamped);
    itemRefs.current[clamped]?.focus();
  };

  const onToolbarKeyDown = (e: React.KeyboardEvent) => {
    if (open) return;
    const last = itemMeta.length - 1;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      focusItem(focusIdx >= last ? 0 : focusIdx + 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusItem(focusIdx <= 0 ? last : focusIdx - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusItem(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusItem(last);
    } else if (e.key === "Backspace" || e.key === "Delete") {
      const meta = itemMeta[focusIdx];
      if (meta?.filterId) {
        e.preventDefault();
        removeFilter(meta.filterId, focusIdx);
      }
    }
  };

  const addFilter = (fieldId: string) => {
    const field = fieldById(fields, fieldId);
    if (!field) return;
    const filter: Filter = {
      id: uid(),
      field: fieldId,
      operator: field.operators[0]?.value ?? "is",
      values: [],
    };
    onChange([...value, filter]);

    setOpen({ kind: "value", filterId: filter.id });
  };

  const changeField = (filterId: string, fieldId: string) => {
    const field = fieldById(fields, fieldId);
    onChange(
      value.map((f) =>
        f.id === filterId
          ? {
              ...f,
              field: fieldId,
              operator: field?.operators[0]?.value ?? f.operator,
              values: [],
            }
          : f
      )
    );
    setOpen({ kind: "value", filterId });
  };

  const changeOperator = (filterId: string, opValue: string) => {
    const filter = value.find((f) => f.id === filterId);
    const field = fieldById(fields, filter?.field ?? "");
    const nextOp = operatorByValue(field, opValue);
    onChange(
      value.map((f) =>
        f.id === filterId
          ? {
              ...f,
              operator: opValue,

              values: nextOp?.multi ? f.values : f.values.slice(0, 1),
            }
          : f
      )
    );
    setOpen(null);
  };

  const toggleValue = (filterId: string, optionValue: string, multi: boolean) => {
    onChange(
      value.map((f) => {
        if (f.id !== filterId) return f;
        if (!multi) return { ...f, values: [optionValue] };
        const has = f.values.includes(optionValue);
        return {
          ...f,
          values: has
            ? f.values.filter((v) => v !== optionValue)
            : [...f.values, optionValue],
        };
      })
    );
    setFlashId(filterId);
    window.setTimeout(() => setFlashId((c) => (c === filterId ? null : c)), 640);
    if (!multi) setOpen(null);
  };

  const removeFilter = (filterId: string, atIdx?: number) => {
    onChange(value.filter((f) => f.id !== filterId));
    setOpen(null);

    const target = Math.max(0, (atIdx ?? focusIdx) - 1);
    requestAnimationFrame(() => focusItem(target));
  };

  const clearAll = () => {
    onChange([]);
    setOpen(null);
    requestAnimationFrame(() => focusItem(0));
  };

  const ensureOptions = React.useCallback(
    (field: FilterFieldDef, query = "") => {
      if (!field.loadOptions) return;
      setAsyncState((s) => ({
        ...s,
        [field.id]: { loading: true, error: false, options: s[field.id]?.options ?? [] },
      }));
      field
        .loadOptions(query)
        .then((options) =>
          setAsyncState((s) => ({
            ...s,
            [field.id]: { loading: false, error: false, options },
          }))
        )
        .catch(() =>
          setAsyncState((s) => ({
            ...s,
            [field.id]: { loading: false, error: true, options: [] },
          }))
        );
    },
    []
  );

  React.useEffect(() => {
    if (!open || open.kind !== "value") return;
    const filter = value.find((f) => f.id === open.filterId);
    const field = fieldById(fields, filter?.field ?? "");
    if (field?.loadOptions && !asyncState[field.id]?.options.length)
      ensureOptions(field);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  let itemIndex = 0;
  const nextRef = () => {
    const idx = itemIndex++;
    return {
      idx,
      register: (el: HTMLButtonElement | null) => {
        itemRefs.current[idx] = el;
      },
      tabIndex: idx === focusIdx ? 0 : -1,
      onFocus: () => setFocusIdx(idx),
    };
  };

  const anchorKey = !open
    ? null
    : open.kind === "add"
    ? "add"
    : `${open.filterId}:${open.kind}`;

  const openPopoverContent = () => {
    if (!open) return null;

    if (open.kind === "add" || open.kind === "field") {
      const items: ListItem[] = fields.map((f) => ({
        value: f.id,
        label: f.label,
        glyph: f.icon,
      }));
      return (
        <SearchList
          key={anchorKey}
          labelId="fb-field-label"
          items={items}
          multi={false}
          onPick={(v) =>
            open.kind === "add" ? addFilter(v) : changeField(open.filterId, v)
          }
        />
      );
    }

    const filter = value.find((f) => f.id === open.filterId);
    const field = fieldById(fields, filter?.field ?? "");
    if (!filter || !field) return null;

    if (open.kind === "operator") {
      const items: ListItem[] = field.operators.map((o) => ({
        value: o.value,
        label: o.label,
        selected: o.value === filter.operator,
      }));
      return (
        <SearchList
          key={anchorKey}
          labelId="fb-op-label"
          items={items}
          multi={false}
          searchable={items.length > 6}
          onPick={(v) => changeOperator(filter.id, v)}
        />
      );
    }

    const op = operatorByValue(field, filter.operator);
    const multi = !!op?.multi;
    const async = field.loadOptions ? asyncState[field.id] : undefined;
    const source = field.loadOptions ? async?.options ?? [] : field.options ?? [];
    const items: ListItem[] = source.map((o) => ({
      value: o.value,
      label: o.label,
      glyph: o.glyph,
      selected: filter.values.includes(o.value),
    }));
    return (
      <SearchList
        key={anchorKey}
        labelId="fb-value-label"
        items={items}
        multi={multi}
        loading={async?.loading}
        error={async?.error}
        onQuery={field.loadOptions ? (q) => ensureOptions(field, q) : undefined}
        onRetry={() => ensureOptions(field)}
        onPick={(v) => toggleValue(filter.id, v, multi)}
      />
    );
  };

  const showClear = value.length > 1;

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-disabled={disabled || undefined}
      onKeyDown={onToolbarKeyDown}
      className={[
        "flex flex-wrap items-center gap-1.5",
        disabled ? "pointer-events-none opacity-50" : "",
        className ?? "",
      ].join(" ")}
    >
      <style>{`
@keyframes fb-flash {
  0% { background-color: rgba(59, 130, 246, 0.18); }
  100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes fb-flash {
    0%, 100% { background-color: transparent; }
  }
}
`}</style>
      <AnimatePresence initial={false} mode="popLayout">
        {value.map((filter) => {
          const field = fieldById(fields, filter.field);
          const op = operatorByValue(field, filter.operator);
          const summary = summarize(
            field?.loadOptions ? asyncState[field.id]?.options : field?.options,
            filter.values
          );
          const fieldItem = nextRef();
          const opItem = nextRef();
          const valueItem = nextRef();
          const removeItem = nextRef();
          const isFlashing = flashId === filter.id;

          return (
            <motion.div
              key={filter.id}
              layout={!reduce}
              initial={reduce ? false : { opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
              transition={springy}
              className="group flex max-w-full items-stretch overflow-hidden rounded-md border border-zinc-950/[0.09] bg-zinc-100/80 dark:border-white/[0.08] dark:bg-white/[0.05]"
            >
              <Segment
                role="field"
                registerRef={fieldItem.register}
                tabIndex={fieldItem.tabIndex}
                onFocus={fieldItem.onFocus}
                anchorKey={`${filter.id}:field`}
                active={open?.kind === "field" && open.filterId === filter.id}
                ariaLabel={`Field: ${field?.label ?? filter.field}. Edit field.`}
                onOpen={() => {
                  setOpen({ kind: "field", filterId: filter.id });
                }}
              >
                {field?.icon && (
                  <span className="text-zinc-500 dark:text-zinc-400" aria-hidden>
                    {field.icon}
                  </span>
                )}
                {field?.label ?? filter.field}
              </Segment>

              <span
                aria-hidden
                className="w-px self-stretch bg-zinc-950/[0.07] dark:bg-white/[0.08]"
              />

              <Segment
                role="operator"
                registerRef={opItem.register}
                tabIndex={opItem.tabIndex}
                onFocus={opItem.onFocus}
                anchorKey={`${filter.id}:operator`}
                muted
                active={open?.kind === "operator" && open.filterId === filter.id}
                ariaLabel={`Operator: ${op?.label ?? filter.operator}. Edit operator.`}
                onOpen={() => {
                  setOpen({ kind: "operator", filterId: filter.id });
                }}
              >
                {op?.label ?? filter.operator}
              </Segment>

              <span
                aria-hidden
                className="w-px self-stretch bg-zinc-950/[0.07] dark:bg-white/[0.08]"
              />

              <Segment
                role="value"
                registerRef={valueItem.register}
                tabIndex={valueItem.tabIndex}
                onFocus={valueItem.onFocus}
                anchorKey={`${filter.id}:value`}
                muted={summary.empty}
                active={open?.kind === "value" && open.filterId === filter.id}
                flash={isFlashing}
                ariaLabel={`Value: ${summary.empty ? "none selected" : summary.text}. Edit value.`}
                onOpen={() => {
                  setOpen({ kind: "value", filterId: filter.id });
                }}
              >
                {!summary.empty && summary.glyphs.length > 0 && (
                  <span className="flex shrink-0 items-center gap-0.5" aria-hidden>
                    {summary.glyphs.map((g, i) => (
                      <span key={i} className="flex items-center">
                        {g}
                      </span>
                    ))}
                  </span>
                )}
                <span className="max-w-[12rem] truncate font-medium text-zinc-900 dark:text-zinc-50">
                  {summary.empty ? (
                    <span className="font-normal text-zinc-400 dark:text-zinc-500">
                      {summary.text}
                    </span>
                  ) : (
                    summary.text
                  )}
                </span>
              </Segment>

              <button
                type="button"
                ref={removeItem.register}
                tabIndex={removeItem.tabIndex}
                onFocus={removeItem.onFocus}
                onClick={() => removeFilter(filter.id, removeItem.idx)}
                aria-label={`Remove ${field?.label ?? filter.field} filter`}
                className="flex shrink-0 items-center px-1.5 text-zinc-400 transition-colors hover:bg-zinc-200/60 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-500/70 active:scale-[0.98] dark:text-zinc-500 dark:hover:bg-white/[0.08] dark:hover:text-zinc-200"
              >
                <CloseIcon />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>

      {(() => {
        const addItem = nextRef();
        const isEmpty = value.length === 0;
        return (
          <button
            type="button"
            ref={addItem.register}
            tabIndex={addItem.tabIndex}
            onFocus={addItem.onFocus}
            data-fb-anchor="add"
            aria-label={isEmpty ? emptyLabel : addLabel}
            aria-haspopup="listbox"
            aria-expanded={open?.kind === "add"}
            onClick={() => {
              setOpen({ kind: "add" });
            }}
            className={[
              "flex items-center gap-1 rounded-md border border-dashed px-2 py-[6px] text-[13px] font-medium leading-none transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 active:scale-[0.98]",
              "border-zinc-300 text-zinc-600 hover:border-zinc-400 hover:bg-zinc-100 hover:text-zinc-900",
              "dark:border-zinc-700 dark:text-zinc-400 dark:hover:border-zinc-600 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100",
            ].join(" ")}
          >
            <PlusIcon />
            {isEmpty ? emptyLabel : addLabel}
          </button>
        );
      })()}

      {showClear && (
        <button
          type="button"
          onClick={clearAll}
          className="ml-0.5 rounded-md px-2 py-[6px] text-[13px] leading-none text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/70 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100"
        >
          Clear
        </button>
      )}

      {open && anchorKey && (
        <Popover anchorKey={anchorKey} onClose={() => setOpen(null)}>
          {openPopoverContent()}
        </Popover>
      )}
    </div>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M6 2.5v7M2.5 6h7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M3 3l6 6M9 3l-6 6"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
      <path
        d="M2.5 6.2l2.2 2.3L9.5 3.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      aria-hidden
      className="animate-spin"
    >
      <circle
        cx="7"
        cy="7"
        r="5.5"
        stroke="currentColor"
        strokeOpacity="0.2"
        strokeWidth="1.5"
      />
      <path
        d="M12.5 7A5.5 5.5 0 0 0 7 1.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default FilterBar;

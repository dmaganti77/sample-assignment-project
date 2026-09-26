"use client";

import * as React from "react";
import { FilterBar, type Filter, type FilterFieldDef } from "@/components/ui/filter-token-bar";

const Ring = ({
  progress = 0,
  dashed = false,
  x = false,
}: {
  progress?: number;
  dashed?: boolean;
  x?: boolean;
}) => {
  const cx = 8;
  const cy = 8;
  const r = 5;
  const a = Math.min(progress, 0.999) * 2 * Math.PI;
  const px = cx + r * Math.sin(a);
  const py = cy - r * Math.cos(a);
  const large = progress > 0.5 ? 1 : 0;
  const pie = `M${cx} ${cy} L${cx} ${cy - r} A${r} ${r} 0 ${large} 1 ${px.toFixed(
    2
  )} ${py.toFixed(2)} Z`;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle
        cx={cx}
        cy={cy}
        r={r}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray={dashed ? "1.5 2" : undefined}
        opacity={dashed ? 0.55 : 0.85}
      />
      {progress >= 1 && <circle cx={cx} cy={cy} r={r} fill="currentColor" />}
      {progress > 0 && progress < 1 && <path d={pie} fill="currentColor" />}
      {x && (
        <path
          d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          opacity="0.7"
        />
      )}
    </svg>
  );
};

const StatusIcon = () => <Ring progress={0.6} />;

const PriorityIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="2.5" y="9" width="3" height="4.5" rx="1" fill="currentColor" />
    <rect x="6.5" y="6" width="3" height="7.5" rx="1" fill="currentColor" />
    <rect x="10.5" y="3" width="3" height="10.5" rx="1" fill="currentColor" />
  </svg>
);

const PriorityGlyph = ({
  level,
}: {
  level: "urgent" | "high" | "medium" | "low" | "none";
}) => {
  const id = React.useId();
  if (level === "urgent") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden>
        <mask id={id}>
          <rect width="16" height="16" fill="white" />
          <rect x="7.15" y="4.3" width="1.7" height="4.7" rx="0.85" fill="black" />
          <circle cx="8" cy="11.3" r="1" fill="black" />
        </mask>
        <rect
          x="2.5"
          y="2.5"
          width="11"
          height="11"
          rx="3"
          fill="currentColor"
          mask={`url(#${id})`}
        />
      </svg>
    );
  }
  if (level === "none") {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" opacity="0.4" aria-hidden>
        <rect x="2.5" y="7.25" width="2.5" height="1.5" rx="0.75" />
        <rect x="6.75" y="7.25" width="2.5" height="1.5" rx="0.75" />
        <rect x="11" y="7.25" width="2.5" height="1.5" rx="0.75" />
      </svg>
    );
  }
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
      <rect x="2.5" y="9" width="3" height="4.5" rx="1" fill="currentColor" opacity={n >= 1 ? 1 : 0.28} />
      <rect x="6.5" y="6" width="3" height="7.5" rx="1" fill="currentColor" opacity={n >= 2 ? 1 : 0.28} />
      <rect x="10.5" y="3" width="3" height="10.5" rx="1" fill="currentColor" opacity={n >= 3 ? 1 : 0.28} />
    </svg>
  );
};

const AVATAR_BG = "e8b84b,4c8c9b,c0532f,8e7cc3,3f7f6f,d98b8b";
const avatarUrl = (seed: string) =>
  `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(
    seed
  )}&backgroundColor=${AVATAR_BG}&backgroundType=solid&radius=50&scale=115`;

const Avatar = ({ seed }: { seed: string }) => (
  <img
    src={avatarUrl(seed)}
    alt=""
    aria-hidden
    width={20}
    height={20}
    className="h-5 w-5 rounded-full ring-1 ring-black/[0.06] dark:ring-white/10"
  />
);

const AssigneeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <circle cx="8" cy="5.5" r="2.6" stroke="currentColor" strokeWidth="1.4" />
    <path
      d="M3 13c.75-2.6 2.6-3.9 5-3.9s4.25 1.3 5 3.9"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    />
  </svg>
);

const LabelIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden>
    <path
      d="M8.4 2.75H3.5a.75.75 0 0 0-.75.75v4.9c0 .3.12.58.33.79l5 5c.44.43 1.14.43 1.58 0l3.9-3.9a1.12 1.12 0 0 0 0-1.58l-5-5A1.1 1.1 0 0 0 8.4 2.75Z"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    />
    <circle cx="5.6" cy="5.6" r="1.05" fill="currentColor" />
  </svg>
);

let labelAttempts = 0;

const fields: FilterFieldDef[] = [
  {
    id: "status",
    label: "Status",
    icon: <StatusIcon />,
    operators: [
      { value: "is", label: "is" },
      { value: "is_not", label: "is not" },
      { value: "is_any", label: "is any of", multi: true },
    ],
    options: [
      { value: "backlog", label: "Backlog", glyph: <Ring dashed /> },
      { value: "todo", label: "Todo", glyph: <Ring progress={0} /> },
      { value: "in_progress", label: "In Progress", glyph: <Ring progress={0.45} /> },
      { value: "in_review", label: "In Review", glyph: <Ring progress={0.75} /> },
      { value: "done", label: "Done", glyph: <Ring progress={1} /> },
      { value: "canceled", label: "Canceled", glyph: <Ring x /> },
    ],
  },
  {
    id: "priority",
    label: "Priority",
    icon: <PriorityIcon />,
    operators: [
      { value: "is", label: "is" },
      { value: "is_not", label: "is not" },
      { value: "is_any", label: "is any of", multi: true },
    ],
    options: [
      { value: "urgent", label: "Urgent", glyph: <PriorityGlyph level="urgent" /> },
      { value: "high", label: "High", glyph: <PriorityGlyph level="high" /> },
      { value: "medium", label: "Medium", glyph: <PriorityGlyph level="medium" /> },
      { value: "low", label: "Low", glyph: <PriorityGlyph level="low" /> },
      { value: "none", label: "No priority", glyph: <PriorityGlyph level="none" /> },
    ],
  },
  {
    id: "assignee",
    label: "Assignee",
    icon: <AssigneeIcon />,
    operators: [
      { value: "is", label: "is" },
      { value: "is_not", label: "is not" },
      { value: "is_any", label: "is any of", multi: true },
    ],

    loadOptions: async (query) => {
      await new Promise((r) => setTimeout(r, 480));
      const people = [
        { value: "u_laziedev", label: "laziedev", glyph: <Avatar seed="laziedev" /> },
        { value: "u_shiawase22", label: "shiawase22", glyph: <Avatar seed="shiawase22" /> },
        { value: "u_khushi", label: "khushi", glyph: <Avatar seed="khushi" /> },
      ];
      const q = query.trim().toLowerCase();
      return q ? people.filter((p) => p.label.toLowerCase().includes(q)) : people;
    },
  },
  {
    id: "label",
    label: "Label",
    icon: <LabelIcon />,
    operators: [
      { value: "is_any", label: "is any of", multi: true },
      { value: "is_none", label: "is none of", multi: true },
    ],
    loadOptions: async () => {
      await new Promise((r) => setTimeout(r, 420));
      labelAttempts += 1;
      if (labelAttempts === 1) throw new Error("network");
      return [
        { value: "bug", label: "bug" },
        { value: "feature", label: "feature" },
        { value: "regression", label: "regression" },
        { value: "needs-triage", label: "needs triage" },
        { value: "good-first-issue", label: "good first issue" },
      ];
    },
  },
];

export default function FilterBarDemo() {
  const [filters, setFilters] = React.useState<Filter[]>([
    { id: "seed-1", field: "status", operator: "is_any", values: ["in_progress", "in_review"] },
    { id: "seed-2", field: "priority", operator: "is", values: ["high"] },
  ]);

  return (
    <div className="flex min-h-[420px] w-full items-center justify-center bg-white p-4 sm:p-10 dark:bg-zinc-950">
      <div className="w-full max-w-2xl">
        <FilterBar fields={fields} value={filters} onChange={setFilters} aria-label="Issue filters" />
      </div>
    </div>
  );
}

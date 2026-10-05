import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Clapperboard, Disc3, Gamepad2, Tv, type LucideIcon } from "lucide-react";
import type { CCBCharacterSummary, CCBSubjectSummary } from "@bakagame/shared";
import { SearchCombobox, SearchOptionContent, type SearchStatus } from "@/components/common/SearchCombobox";
import { Button } from "@/components/ui/Button";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCBCharacterImage } from "./CCBCharacterImage";

const KEYWORD_MAX = 80;
const EMPTY_TEXT = "没有找到符合条件的结果";

/** Bangumi 条目类型：图标区分作品形态，读屏读出同名文字。 */
const SUBJECT_TYPES: Record<number, { icon: LucideIcon; label: string }> = {
  1: { icon: BookOpen, label: "书籍" },
  2: { icon: Tv, label: "动画" },
  3: { icon: Disc3, label: "音乐" },
  4: { icon: Gamepad2, label: "游戏" },
  6: { icon: Clapperboard, label: "三次元" },
};

/** 只认最近一次发起的请求：旧查询晚到的结果、组件卸载后的回调一律丢弃。 */
function useLatestRequest() {
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  return useMemo(() => ({
    begin: () => ++generation.current,
    current: () => generation.current,
    isLatest: (request: number) => request === generation.current,
  }), []);
}

/** 副名只在和主名不同时显示，省得同一串字出现两遍。 */
const secondName = (item: { name: string; nameCn: string }) => (item.nameCn && item.nameCn !== item.name ? item.nameCn : undefined);

function SubjectGlyph({ type }: { type: number }) {
  const { icon: Icon, label } = SUBJECT_TYPES[type] ?? SUBJECT_TYPES[2]!;
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

function CharacterOption({ character, banned }: { character: CCBCharacterSummary; banned: boolean }) {
  return (
    <SearchOptionContent
      media={<CCBCharacterImage character={character} className="size-9" />}
      title={character.name}
      subtitle={secondName(character)}
      trailing={banned ? "已被选择" : undefined}
    />
  );
}

function SubjectOption({ subject, trailing }: { subject: CCBSubjectSummary; trailing?: string }) {
  return (
    <SearchOptionContent
      media={<SubjectGlyph type={subject.type} />}
      title={subject.name}
      subtitle={secondName(subject)}
      trailing={trailing ?? (subject.year ? String(subject.year) : undefined)}
    />
  );
}

type Mode = "character" | "subject";

type Listing =
  | { kind: "none"; key: string }
  | { kind: "characters"; key: string; characters: CCBCharacterSummary[] }
  | { kind: "subjects"; key: string; subjects: CCBSubjectSummary[] }
  /** 从作品结果点进某部作品：角色列表顶上带返回行，返回时回到原来的作品结果。 */
  | { kind: "cast"; key: string; subjects: CCBSubjectSummary[]; subject: CCBSubjectSummary; characters: CCBCharacterSummary[] };

type Option = { kind: "character"; character: CCBCharacterSummary } | { kind: "subject"; subject: CCBSubjectSummary };

const optionKey = (option: Option) => (option.kind === "character" ? `c-${option.character.id}` : `s-${option.subject.id}`);

/**
 * 角色搜索：输入框右侧是「搜角色」「搜作品」两个按钮，结果浮在游戏区之上。
 * 上一次用哪个按钮搜，那个按钮就是实心的，回车沿用它。搜作品后点作品进入它的角色列表，顶上一行可返回作品结果。
 * 点角色即提交；`onSelect` 返回 `false` 表示没成功，结果保留可以换一个，否则清空输入与结果，面板随之退场。
 */
export function CCBSearch({ allowSubjects, disabled = false, bannedIds = [], onSelect }: {
  allowSubjects: boolean;
  disabled?: boolean;
  bannedIds?: number[];
  onSelect: (character: CCBCharacterSummary) => Promise<boolean | void> | boolean | void;
}) {
  const latest = useLatestRequest();
  const [keyword, setKeyword] = useState("");
  const [mode, setMode] = useState<Mode>("character");
  const [listing, setListing] = useState<Listing>({ kind: "none", key: "none" });
  const [loading, setLoading] = useState<Mode | null>(null);
  const [error, setError] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const query = keyword.trim();

  const search = async (target: Mode) => {
    setMode(target);
    if (!query || disabled) return;
    const request = latest.begin();
    setLoading(target);
    setError("");
    try {
      // 走 store 封装：同一串关键词在复用窗口内不会重复请求上游。
      const store = useCCBStore.getState();
      const next: Listing = target === "character"
        ? { kind: "characters", key: `characters-${request}`, characters: await store.searchCharacters(query) }
        : { kind: "subjects", key: `subjects-${request}`, subjects: await store.searchSubjects(query) };
      if (latest.isLatest(request)) setListing(next);
    } catch (failure) {
      if (latest.isLatest(request)) setError(ccbErrorMessage(failure));
    } finally {
      if (latest.isLatest(request)) setLoading(null);
    }
  };

  const openSubject = async (subject: CCBSubjectSummary, subjects: CCBSubjectSummary[]) => {
    const request = latest.begin();
    const key = `s-${subject.id}`;
    setPendingKey(key);
    setError("");
    try {
      const characters = await useCCBStore.getState().loadSubjectCharacters(subject.id);
      if (latest.isLatest(request)) setListing({ kind: "cast", key: `cast-${request}`, subjects, subject, characters });
    } catch (failure) {
      if (latest.isLatest(request)) setError(ccbErrorMessage(failure));
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
  };

  const choose = async (character: CCBCharacterSummary) => {
    // 不推进请求代次：提交期间又发起了新查询的话，清空留给新查询的结果就不对了。
    const request = latest.current();
    const key = `c-${character.id}`;
    setPendingKey(key);
    let accepted: boolean | void;
    try {
      accepted = await onSelect(character);
    } catch (failure) {
      setError(ccbErrorMessage(failure));
      return;
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
    if (accepted === false || !latest.isLatest(request)) return;
    latest.begin();
    setKeyword("");
    setError("");
    setLoading(null);
    setListing({ kind: "none", key: "none" });
  };

  const options: Option[] = listing.kind === "subjects"
    ? listing.subjects.map((subject) => ({ kind: "subject", subject }))
    : listing.kind === "none" ? [] : listing.characters.map((character) => ({ kind: "character", character }));

  const status: SearchStatus | null = error ? { tone: "error", text: error }
    : loading && options.length === 0 ? { tone: "busy", text: loading === "character" ? "正在搜索角色" : "正在搜索作品" }
      : listing.kind !== "none" && !loading && options.length === 0
        ? { tone: "info", text: listing.kind === "cast" ? "这部作品下没有可选的角色" : EMPTY_TEXT }
        : null;

  const searchButton = (target: Mode, text: string) => (
    <Button
      type="button"
      variant={mode === target ? "default" : "outline"}
      className="h-10"
      disabled={disabled || !query}
      onClick={() => void search(target)}
    >
      {text}
    </Button>
  );

  return (
    <section aria-label="角色搜索">
      <SearchCombobox
        value={keyword}
        onValueChange={setKeyword}
        label="搜索角色"
        placeholder={allowSubjects ? "角色名、作品名或编号" : "角色名、别名或编号"}
        maxLength={KEYWORD_MAX}
        disabled={disabled}
        onSubmit={() => void search(mode)}
        busy={loading !== null && options.length > 0}
        options={options}
        getKey={optionKey}
        isOptionDisabled={(option) => option.kind === "character" && bannedIds.includes(option.character.id)}
        renderOption={(option) => option.kind === "character"
          ? <CharacterOption character={option.character} banned={bannedIds.includes(option.character.id)} />
          : <SubjectOption subject={option.subject} />}
        onSelect={(option) => {
          if (option.kind === "character") void choose(option.character);
          else if (listing.kind === "subjects") void openSubject(option.subject, listing.subjects);
        }}
        pendingKey={pendingKey}
        listKey={listing.key}
        status={status}
        back={listing.kind === "cast" ? {
          label: "返回作品",
          detail: listing.subject.nameCn || listing.subject.name,
          onBack: () => {
            latest.begin();
            setPendingKey(null);
            setError("");
            setListing({ kind: "subjects", key: `subjects-back-${listing.key}`, subjects: listing.subjects });
          },
        } : null}
        actions={(
          <>
            {searchButton("character", "搜角色")}
            {allowSubjects ? searchButton("subject", "搜作品") : null}
          </>
        )}
      />
    </section>
  );
}

/**
 * 设置里的追加作品：只搜作品，点一部即加入。面板不收起，已加入的作品原地变为不可选并标「已添加」，可以接着加下一部。
 */
export function CCBSubjectSearch({ addedIds, disabled = false, onAdd }: {
  addedIds: number[];
  disabled?: boolean;
  onAdd: (subject: CCBSubjectSummary) => void;
}) {
  const latest = useLatestRequest();
  const [keyword, setKeyword] = useState("");
  const [subjects, setSubjects] = useState<{ key: string; items: CCBSubjectSummary[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const query = keyword.trim();

  const search = async () => {
    if (!query || disabled) return;
    const request = latest.begin();
    setLoading(true);
    setError("");
    try {
      const items = await useCCBStore.getState().searchSubjects(query);
      if (latest.isLatest(request)) setSubjects({ key: `subjects-${request}`, items });
    } catch (failure) {
      if (latest.isLatest(request)) setError(ccbErrorMessage(failure));
    } finally {
      if (latest.isLatest(request)) setLoading(false);
    }
  };

  const items = subjects?.items ?? [];
  const status: SearchStatus | null = error ? { tone: "error", text: error }
    : loading && items.length === 0 ? { tone: "busy", text: "正在搜索作品" }
      : subjects && !loading && items.length === 0 ? { tone: "info", text: EMPTY_TEXT }
        : null;

  return (
    <section aria-label="追加作品搜索">
      <SearchCombobox
        value={keyword}
        onValueChange={setKeyword}
        label="搜索作品"
        placeholder="作品名或编号"
        maxLength={KEYWORD_MAX}
        disabled={disabled}
        onSubmit={() => void search()}
        busy={loading && items.length > 0}
        options={items}
        getKey={(subject) => String(subject.id)}
        isOptionDisabled={(subject) => addedIds.includes(subject.id)}
        renderOption={(subject) => <SubjectOption subject={subject} trailing={addedIds.includes(subject.id) ? "已添加" : undefined} />}
        onSelect={onAdd}
        listKey={subjects?.key ?? "none"}
        status={status}
        actions={(
          <Button type="button" className="h-10" disabled={disabled || !query} onClick={() => void search()}>
            搜作品
          </Button>
        )}
      />
    </section>
  );
}

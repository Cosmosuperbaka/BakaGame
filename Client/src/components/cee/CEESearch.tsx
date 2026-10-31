import { useEffect, useRef, useState, type ReactNode } from "react";
import { BookOpen, Clapperboard, Disc3, Gamepad2, Tv, type LucideIcon } from "lucide-react";
import type { CEECharacterSummary, CEESubjectSummary } from "@bakagame/shared";
import {
  SearchCombobox,
  SearchOptionContent,
  type SearchStatus,
} from "@/components/common/SearchCombobox";
import { Button } from "@/components/ui/Button";
import { useIdleSearch } from "@/hooks/UseIdleSearch";
import { useCEEDataSource } from "@/lib/CEEDataSource";
import { ceeErrorMessage, useCEEStore } from "@/stores/UseCEEStore";
import { CEECharacterImage, CEESubjectImage } from "./CEECharacterImage";

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

/** 副名只在和主名不同时显示，省得同一串字出现两遍。 */
const secondName = (item: { name: string; nameCn: string }) =>
  item.nameCn && item.nameCn !== item.name ? item.nameCn : undefined;

/** 作品封面；还没有图时用条目类型图标占位。类型另以读屏文字给出，有封面时也读得到。 */
function SubjectMedia({ subject }: { subject: CEESubjectSummary }) {
  const { icon: Icon, label } = SUBJECT_TYPES[subject.type] ?? SUBJECT_TYPES[2]!;
  return (
    <>
      <CEESubjectImage
        subject={subject}
        fallback={<Icon className="size-4" aria-hidden="true" />}
      />
      <span className="sr-only">{label}</span>
    </>
  );
}

function CharacterOption({
  character,
  banned,
}: {
  character: CEECharacterSummary;
  banned: boolean;
}) {
  return (
    <SearchOptionContent
      media={<CEECharacterImage character={character} className="size-9" />}
      title={character.name}
      subtitle={secondName(character)}
      trailing={banned ? "已被选择" : undefined}
    />
  );
}

function SubjectOption({ subject, trailing }: { subject: CEESubjectSummary; trailing?: string }) {
  return (
    <SearchOptionContent
      media={<SubjectMedia subject={subject} />}
      title={subject.name}
      subtitle={secondName(subject)}
      trailing={trailing ?? (subject.year ? String(subject.year) : undefined)}
    />
  );
}

export type CEESearchMode = "character" | "subject";

/** 从作品结果点进某部作品后的角色列表，顶上带返回行。 */
interface Cast {
  key: string;
  subject: CEESubjectSummary;
  characters: CEECharacterSummary[];
}

type Option =
  | { kind: "character"; character: CEECharacterSummary }
  | { kind: "subject"; subject: CEESubjectSummary };

const optionKey = (option: Option) =>
  option.kind === "character" ? `c-${option.character.id}` : `s-${option.subject.id}`;

const MODE_TEXT: Record<CEESearchMode, { button: string; busy: string }> = {
  character: { button: "搜角色", busy: "正在搜索角色" },
  subject: { button: "搜作品", busy: "正在搜索作品" },
};

/** 面板当前的行：进作品后只列这部作品的角色，否则按当前范围列搜索结果。 */
function buildOptions(view: {
  cast: Cast | null;
  mode: CEESearchMode;
  characters: CEECharacterSummary[];
  subjects: CEESubjectSummary[];
}): Option[] {
  const { cast, mode, characters, subjects } = view;
  if (cast) return cast.characters.map((character): Option => ({ kind: "character", character }));
  if (mode === "subject") return subjects.map((subject): Option => ({ kind: "subject", subject }));
  return characters.map((character): Option => ({ kind: "character", character }));
}

/**
 * 输入框下方的状态行：选角/进作品的动作失败优先，其次作品下没有角色，
 * 再往下是整批结果为空的忙态与空结果。
 */
function buildStatus(view: {
  actionError: string;
  cast: Cast | null;
  mode: CEESearchMode;
  search: { error: string; loading: boolean; empty: boolean };
  optionCount: number;
}): SearchStatus | null {
  const { actionError, cast, mode, search, optionCount } = view;
  if (actionError) return { tone: "error", text: actionError };
  if (cast)
    return cast.characters.length ? null : { tone: "info", text: "这部作品下没有可选的角色" };
  if (search.error) return { tone: "error", text: search.error };
  if (search.loading && optionCount === 0) return { tone: "busy", text: MODE_TEXT[mode].busy };
  if (search.empty) return { tone: "info", text: EMPTY_TEXT };
  return null;
}

/** 角色行整行置灰的条件：作品行不受 `bannedIds` 影响。 */
const isBannedOption = (option: Option, bannedIds: number[]) =>
  option.kind === "character" && bannedIds.includes(option.character.id);

/** 一行结果：角色带「已被选择」，作品带封面与年份。 */
function ResultRow({ option, banned }: { option: Option; banned: boolean }) {
  if (option.kind === "subject") return <SubjectOption subject={option.subject} />;
  return <CharacterOption character={option.character} banned={banned} />;
}

/** 查询范围切换钮：当前范围实心并带 `aria-pressed`。 */
function ModeButton({
  active,
  target,
  disabled,
  onSwitch,
  controlId,
}: {
  active: boolean;
  target: CEESearchMode;
  disabled: boolean;
  onSwitch: (target: CEESearchMode) => void;
  controlId?: string;
}) {
  return (
    <Button
      type="button"
      variant={active ? "default" : "outline"}
      aria-pressed={active}
      // 收窄左右留白：猜测时后面还跟着「放弃本局」，1440 宽房间页的游戏区要能把三个按钮与输入框排在一行
      className="h-10 px-3"
      disabled={disabled}
      onClick={() => onSwitch(target)}
      data-agent-control={controlId}
    >
      {MODE_TEXT[target].button}
    </Button>
  );
}

/**
 * 角色搜索：停止输入后自动查询，结果浮在游戏区之上。输入框右侧「搜角色」「搜作品」切换查询范围，
 * 当前范围的按钮是实心的；切换后用同一串关键词立即重查，回车也立即查当前范围。
 * 搜作品后点作品进入它的角色列表，顶上一行可返回作品结果；改关键词或换范围即离开角色列表。
 * 点角色即提交；`onSelect` 返回 `false` 表示没成功，结果保留可以换一个，否则清空输入与结果，面板随之退场。
 * `trailing` 是与搜索同属一次提交的动作（「放弃本局」），排在搜索按钮之后、同一组里一起换行。
 */
export function CEESearch({
  allowSubjects,
  defaultMode = "character",
  disabled = false,
  bannedIds = [],
  trailing,
  onSelect,
  agentControlPrefix,
}: {
  allowSubjects: boolean;
  /** 初始查询范围；不允许搜作品时总是角色 */
  defaultMode?: CEESearchMode;
  disabled?: boolean;
  bannedIds?: number[];
  trailing?: ReactNode;
  onSelect: (character: CEECharacterSummary) => Promise<boolean | void> | boolean | void;
  /** Agent 操作追踪：输入框、模式按钮与结果行的控件 id 前缀。 */
  agentControlPrefix?: string;
}) {
  const source = useCEEDataSource();
  const searchCharacters = source.searchCharacters;
  const searchSubjects = source.searchSubjects;
  const controlled = source.useControlled();
  const [keyword, setKeyword] = useState("");
  const [chosenMode, setMode] = useState<CEESearchMode>(defaultMode);
  const mode: CEESearchMode = allowSubjects ? chosenMode : "character";
  const [cast, setCast] = useState<Cast | null>(null);
  const [actionError, setActionError] = useState("");
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  // 进作品、提交角色都是异步的：只认最近一次，期间改了关键词或离开列表的话晚到的结果丢弃。
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    []
  );

  // MCP 接管时输入由服务端驱动；人类页面只回显文本，不再自己发查询。
  const characterSearch = useIdleSearch(keyword, searchCharacters, ceeErrorMessage, {
    enabled: mode === "character" && !disabled && !controlled,
    scope: "character",
  });
  const subjectSearch = useIdleSearch(keyword, searchSubjects, ceeErrorMessage, {
    enabled: mode === "subject" && !disabled && !controlled,
    scope: "subject",
  });
  const search = mode === "character" ? characterSearch : subjectSearch;

  const leaveCast = () => {
    generation.current++;
    setCast(null);
    setPendingKey(null);
    setActionError("");
  };

  const switchMode = (target: CEESearchMode) => {
    if (target !== mode) {
      leaveCast();
      setMode(target);
    }
    // 同一范围再按一次也算「立即搜」，不必等停顿。
    (target === "character" ? characterSearch : subjectSearch).flush();
  };

  const openSubject = async (subject: CEESubjectSummary) => {
    const request = ++generation.current;
    const key = `s-${subject.id}`;
    setPendingKey(key);
    setActionError("");
    try {
      const characters = await source.loadSubjectCharacters(subject.id);
      if (request === generation.current)
        setCast({ key: `cast-${subject.id}-${request}`, subject, characters });
    } catch (failure) {
      if (request === generation.current) setActionError(ceeErrorMessage(failure));
    } finally {
      if (request === generation.current) setPendingKey(null);
    }
  };

  const choose = async (character: CEECharacterSummary) => {
    // 不推进请求代次：提交期间又改了关键词的话，清空留给新查询的结果就不对了。
    const request = generation.current;
    const key = `c-${character.id}`;
    setPendingKey(key);
    let accepted: boolean | void;
    try {
      accepted = await onSelect(character);
    } catch (failure) {
      setActionError(ceeErrorMessage(failure));
      return;
    } finally {
      setPendingKey((current) => (current === key ? null : current));
    }
    if (accepted === false || request !== generation.current) return;
    leaveCast();
    setKeyword("");
  };

  const options = buildOptions({
    cast,
    mode,
    characters: characterSearch.items,
    subjects: subjectSearch.items,
  });
  const status = buildStatus({ actionError, cast, mode, search, optionCount: options.length });

  /** 改关键词即离开作品角色列表与动作报错；只在真的挂着它们时清理。 */
  const changeKeyword = (value: string) => {
    setKeyword(value);
    if (cast || actionError) leaveCast();
  };
  /** 回车与「搜角色/搜作品」都是立即查当前范围。 */
  const submit = cast ? undefined : search.flush;
  const pickOption = (option: Option) => {
    if (option.kind === "character") {
      void choose(option.character);
      return;
    }
    void openSubject(option.subject);
  };

  return (
    <section aria-label="角色搜索">
      <SearchCombobox
        value={keyword}
        onValueChange={changeKeyword}
        label="搜索角色"
        placeholder={mode === "subject" ? "作品名或编号，再从作品里选角色" : "角色名、别名或编号"}
        maxLength={KEYWORD_MAX}
        disabled={disabled}
        onSubmit={submit}
        busy={!cast && search.loading && options.length > 0}
        options={options}
        getKey={optionKey}
        isOptionDisabled={(option) => isBannedOption(option, bannedIds)}
        renderOption={(option) => (
          <ResultRow option={option} banned={isBannedOption(option, bannedIds)} />
        )}
        onSelect={pickOption}
        pendingKey={pendingKey}
        listKey={cast ? cast.key : `${mode}:${search.listKey}`}
        status={status}
        agentControlId={agentControlPrefix ? `${agentControlPrefix}.input` : undefined}
        agentControlPrefix={agentControlPrefix}
        back={
          cast
            ? {
                label: "返回作品",
                detail: cast.subject.nameCn || cast.subject.name,
                onBack: leaveCast,
              }
            : null
        }
        actions={
          <>
            <ModeButton
              active={mode === "character"}
              target="character"
              disabled={disabled}
              onSwitch={switchMode}
              controlId={agentControlPrefix ? `${agentControlPrefix}.mode.character` : undefined}
            />
            {allowSubjects ? (
              <ModeButton
                active={mode === "subject"}
                target="subject"
                disabled={disabled}
                onSwitch={switchMode}
                controlId={agentControlPrefix ? `${agentControlPrefix}.mode.subject` : undefined}
              />
            ) : null}
            {trailing}
          </>
        }
      />
    </section>
  );
}

/**
 * 设置里的追加作品：只搜作品，停止输入后自动查询，点一部即加入。
 * 面板不收起，已加入的作品原地变为不可选并标「已添加」，可以接着加下一部。
 */
export function CEESubjectSearch({
  addedIds,
  disabled = false,
  onAdd,
}: {
  addedIds: number[];
  disabled?: boolean;
  onAdd: (subject: CEESubjectSummary) => void;
}) {
  const searchSubjects = useCEEStore((state) => state.searchSubjects);
  const [keyword, setKeyword] = useState("");
  const search = useIdleSearch(keyword, searchSubjects, ceeErrorMessage, { enabled: !disabled });

  const status: SearchStatus | null = search.error
    ? { tone: "error", text: search.error }
    : search.loading && search.items.length === 0
      ? { tone: "busy", text: "正在搜索作品" }
      : search.empty
        ? { tone: "info", text: EMPTY_TEXT }
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
        onSubmit={search.flush}
        busy={search.loading && search.items.length > 0}
        options={search.items}
        getKey={(subject) => String(subject.id)}
        isOptionDisabled={(subject) => addedIds.includes(subject.id)}
        renderOption={(subject) => (
          <SubjectOption
            subject={subject}
            trailing={addedIds.includes(subject.id) ? "已添加" : undefined}
          />
        )}
        onSelect={onAdd}
        listKey={search.listKey}
        status={status}
      />
    </section>
  );
}

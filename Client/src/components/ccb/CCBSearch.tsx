import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import type { CCBCharacterSummary, CCBSubjectSummary } from "@bakagame/shared";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { ccbErrorMessage, useCCBStore } from "@/stores/UseCCBStore";
import { CCBCharacterImage } from "./CCBCharacterImage";

export function CCBSearch({ allowSubjects, disabled = false, bannedIds = [], onSelect, subjectsOnly = false }: {
  allowSubjects: boolean; disabled?: boolean; bannedIds?: number[];
  onSelect: (character: CCBCharacterSummary) => Promise<void> | void;
  subjectsOnly?: boolean;
}) {
  const [mode, setMode] = useState<"character" | "subject">(subjectsOnly ? "subject" : "character");
  const [keyword, setKeyword] = useState("");
  const [characters, setCharacters] = useState<CCBCharacterSummary[]>([]);
  const [subjects, setSubjects] = useState<CCBSubjectSummary[]>([]);
  const [selectedSubject, setSelectedSubject] = useState<CCBSubjectSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const search = async () => {
    if (!keyword.trim() || disabled || loading) return;
    const request = ++generation.current;
    setLoading(true); setError(""); setSelectedSubject(null);
    try {
      const store = useCCBStore.getState();
      if (mode === "character") {
        // 走 store 封装：同一串关键词在复用窗口内不会重复请求上游。
        const results = await store.searchCharacters(keyword.trim());
        if (request === generation.current) { setCharacters(results); setSubjects([]); }
      } else {
        const results = await store.searchSubjects(keyword.trim());
        if (request === generation.current) { setSubjects(results); setCharacters([]); }
      }
      if (request === generation.current) setSearched(true);
    } catch (failure) { if (request === generation.current) setError(ccbErrorMessage(failure)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  const chooseSubject = async (subject: CCBSubjectSummary) => {
    if (subjectsOnly) { await onSelect(subject); return; }
    const request = ++generation.current;
    setLoading(true); setError("");
    try {
      const results = await useCCBStore.getState().loadSubjectCharacters(subject.id);
      if (request === generation.current) { setCharacters(results); setSelectedSubject(subject); }
    } catch (failure) { if (request === generation.current) setError(ccbErrorMessage(failure)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  return <section className="space-y-3" aria-label={subjectsOnly ? "追加作品搜索" : "角色搜索"}>
    {allowSubjects && !subjectsOnly ? <Tabs value={mode} onValueChange={(value) => { generation.current++; setMode(value as typeof mode); setCharacters([]); setSubjects([]); setSelectedSubject(null); setSearched(false); setLoading(false); }}><TabsList><TabsTrigger value="character">搜角色</TabsTrigger><TabsTrigger value="subject">搜作品</TabsTrigger></TabsList></Tabs> : null}
    <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <Input value={keyword} onChange={(event) => setKeyword(event.target.value)} maxLength={80} placeholder={mode === "character" ? "角色名、别名或编号" : "作品名或编号"} aria-label={mode === "character" ? "搜索角色" : "搜索作品"} disabled={disabled} />
      <Button type="submit" loading={loading} disabled={disabled || !keyword.trim()}><Search />搜索</Button>
    </form>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {selectedSubject ? <Button variant="ghost" size="sm" onClick={() => { setSelectedSubject(null); setCharacters([]); }}><ArrowLeft />{selectedSubject.nameCn || selectedSubject.name}</Button> : null}
    <div className="max-h-72 space-y-1 overflow-y-auto">
      {mode === "subject" && !selectedSubject ? subjects.map((subject) => <Button key={subject.id} variant="ghost" className="h-auto w-full justify-between whitespace-normal text-left" disabled={disabled || loading} onClick={() => void chooseSubject(subject)}><span className="min-w-0"><span className="block">{subject.nameCn || subject.name}</span><span className="text-xs text-muted-foreground">{subject.name} · #{subject.id}</span></span><span className="shrink-0 text-xs">{subject.year ?? "年份未知"}</span></Button>) : characters.map((character) => <Button key={character.id} variant="ghost" className="h-auto w-full justify-start text-left" disabled={disabled || loading || bannedIds.includes(character.id)} onClick={() => void onSelect(character)}>
        <CCBCharacterImage character={character} />
        <span className="min-w-0 flex-1"><span className="block truncate">{character.nameCn || character.name}</span><span className="block truncate text-xs text-muted-foreground">{character.name} · #{character.id}</span></span>
        {bannedIds.includes(character.id) ? <span className="text-xs text-muted-foreground">已被选择</span> : null}
      </Button>)}
    </div>
    {searched && !loading && !(mode === "subject" && !selectedSubject ? subjects.length : characters.length) ? <p className="text-sm text-muted-foreground">没有找到符合条件的结果</p> : null}
  </section>;
}

import type { Database } from "bun:sqlite";
import { AppError } from "../../domain/Errors";
import type { CEECharacterView, CEEExtraTagSection, CEESettings } from "../../shared/CEE";
import type { CEEEnrichment } from "../CEEEnrichment";
import { deriveCEECharacter } from "../CEECharacterDerivation";
import type { CEERawAppearance, CEERawCharacter } from "../CEEData";
import {
  positiveId,
  toCharacterSummary,
  type CEEContext,
  type CharacterRow,
  type SubjectRow,
} from "./Rows";

/** 角色原始资料装配：本地库 + 补充资料，派生判定前的那一份。 */
export class CEERawCharacterReader {
  private readonly db: Database;
  private readonly enrichment: CEEEnrichment;
  private readonly now: () => number;

  constructor(ctx: CEEContext) {
    this.db = ctx.db;
    this.enrichment = ctx.enrichment;
    this.now = ctx.now;
  }

  async getRawCharacter(id: number): Promise<CEERawCharacter> {
    if (!positiveId(id)) throw new AppError("CEE_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const row = this.db.query("SELECT * FROM characters WHERE id=?").get(id) as CharacterRow | null;
    if (!row) throw new AppError("CEE_CHARACTER_NOT_FOUND", "本地角色资料不存在");
    const supplement = this.enrichment.readCharacter(id);
    const appearances = this.db
      .query(
        `SELECT s.*,r.relation_type FROM character_subject_relations r JOIN subjects s ON s.id=r.subject_id
      WHERE r.character_id=? AND r.relation_type IN (1,2) AND s.nsfw=0 ORDER BY r.subject_id LIMIT 2001`
      )
      .all(id) as SubjectRow[];
    if (appearances.length > 2000)
      throw new AppError("CEE_CHARACTER_TOO_LARGE", "角色登场作品过多，无法用于本局");
    const tags = this.db
      .query<{ tag: string }, [number]>(
        "SELECT tag FROM character_tags WHERE character_id=? ORDER BY position"
      )
      .all(id);
    const voices = this.db
      .query<{ name: string }, [number]>(
        "SELECT name FROM character_vas WHERE character_id=? ORDER BY position"
      )
      .all(id);
    const extraRows = this.db
      .query<{ subject_id: number; section: string; tag: string }, [number]>(
        "SELECT subject_id,section,tag FROM character_extra_tags WHERE character_id=? ORDER BY subject_id,section_position,tag_position"
      )
      .all(id);
    const extraTagsBySubject: Record<number, CEEExtraTagSection[]> = {};
    for (const row of extraRows) {
      const sections = (extraTagsBySubject[row.subject_id] ??= []);
      let section = sections.at(-1);
      if (!section || section.section !== row.section) {
        section = { section: row.section, tags: [] };
        sections.push(section);
      }
      section.tags.push(row.tag);
    }
    return {
      ...toCharacterSummary(this.enrichment, row),
      aliases: supplement.aliases ?? (JSON.parse(row.aliases) as string[]),
      gender:
        supplement.gender ?? (row.gender === "male" || row.gender === "female" ? row.gender : "?"),
      popularity: supplement.popularity ?? row.collects + row.comments,
      summary: supplement.summary ?? row.summary,
      appearances: appearances.map((item): CEERawAppearance => ({
        id: item.id,
        type: item.type,
        name: item.name,
        nameCn: item.name_cn || item.name,
        date: item.date,
        relationType: item.relation_type!,
        rating: item.score,
        ratingCount: item.rating_count,
        heat: item.heat,
        rawTags: JSON.parse(item.raw_tags) as Record<string, number>,
        metaTags: JSON.parse(item.meta_tags) as string[],
      })),
      characterTags: tags.map((item) => item.tag),
      voiceActors: [...new Set(voices.map((item) => item.name))],
      extraTagsBySubject,
    };
  }

  async getCharacter(id: number, settings: CEESettings): Promise<CEECharacterView> {
    return deriveCEECharacter(await this.getRawCharacter(id), settings, this.now());
  }
}

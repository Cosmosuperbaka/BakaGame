import type { CCBCharacterView, CCBSettings } from '../shared/CCB';
import type { CCBDataProvider, CCBRawCharacter } from '../infrastructure/CCBData';
import { selectCCBExtraTags } from '../infrastructure/CCBCharacterDerivation';
import extraSubjectIds from '../shared/CCBExtraSubjects.json';
import { AppError } from '../domain/Errors';

/** 同房同局共享本地查询结果；上游角色快照只补附加标签。 */
export class CCBOriginalRoundData {
  private readonly characters = new Map<number, Promise<CCBCharacterView>>();
  private readonly extras = new Map<number, Promise<CCBRawCharacter | null>>();
  constructor(private readonly data: CCBDataProvider) {}

  getCharacter(id: number, settings: CCBSettings): Promise<CCBCharacterView> {
    let pending = this.characters.get(id);
    if (!pending) {
      pending = this.data.getCharacter(id, settings).then(character => structuredClone(character))
        .catch(error => { this.characters.delete(id); throw error; });
      this.characters.set(id, pending);
    }
    return pending;
  }

  async supplement(character: CCBCharacterView): Promise<CCBCharacterView> {
    if (!character.comparisonAppearances.some(item => extraSubjectIds.includes(item.id))) return { ...character, extraTags: [] };
    let pending = this.extras.get(character.id);
    if (!pending) {
      pending = this.data.getRawCharacter(character.id).then(raw => structuredClone(raw)).catch(error => {
        if (error instanceof AppError && error.code === 'CCB_CHARACTER_NOT_FOUND') return null;
        this.extras.delete(character.id); throw error;
      });
      this.extras.set(character.id, pending);
    }
    const raw = await pending;
    const comparisonAppearances = character.comparisonAppearances.map(item => {
      const local = raw?.appearances.find(appearance => appearance.id === item.id);
      const name = item.name || local?.name || (item.id > 0 ? `作品 ${item.id}` : '');
      return { id: item.id, name, nameCn: item.nameCn || local?.nameCn || name };
    });
    return { ...character, comparisonAppearances, extraTags: selectCCBExtraTags(comparisonAppearances, raw?.extraTagsBySubject ?? {}) };
  }
}

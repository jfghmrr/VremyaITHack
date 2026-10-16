// Возрастная группа при регистрации: до 14 лет нужен родитель или законный представитель
// (ст. 28 ГК РФ). Проверка на клиенте дублирует серверную и даёт понятное сообщение.
export type AgeGroup = "14plus" | "under14";

export function ageProblem(ageGroup: string, parentName: string, parentConsent: boolean): string {
  if (ageGroup !== "14plus" && ageGroup !== "under14") return "Укажи свой возраст.";
  if (ageGroup === "under14") {
    if (!parentConsent) return "Нужно разрешение родителя или законного представителя.";
    const length = parentName.trim().length;
    if (length < 2 || length > 64) return "Укажи имя родителя или законного представителя: от 2 до 64 символов.";
  }
  return "";
}

/** Имя родителя отправляется только для группы «до 14 лет». */
export const parentNameFor = (ageGroup: AgeGroup, parentName: string) => (ageGroup === "under14" ? parentName.trim() : null);

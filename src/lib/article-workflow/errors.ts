/**
 * テンプレートの組み立てが入力 (ドシエの中身) の不備で進められないときの例外 (#170)。
 *
 * 純粋関数の層 (`templates/`) は DB を知らないのでここで定義し、domain 層
 * (`src/lib/domain/article-generate.ts`) が器ごとの入力エラー (`MeetGreetInputError` 等) に
 * 包み直す。REST は 400、画面はそのまま文言を出す
 */
export class TemplateInputError extends Error {}

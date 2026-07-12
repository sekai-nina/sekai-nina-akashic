-- Add 'annotation' TextType for per-performance notes (e.g. ライブのダブルアンコール等の文脈)
ALTER TYPE "TextType" ADD VALUE IF NOT EXISTS 'annotation';

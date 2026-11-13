-- 분야(카테고리) 목록을 기기 간에 동기화하기 위한 추가 SQL.
-- 이미 schema.sql을 실행한 프로젝트에서 Supabase 대시보드 → SQL Editor 에 붙여 넣고 한 번 Run.
-- 여러 번 실행해도 안전하다.

alter table public.meta add column if not exists cats jsonb;
alter table public.meta add column if not exists cats_updated_at timestamptz;

-- 갈래 생일은 합집합, 분야 목록은 더 최근에 고친 쪽이 이긴다
create or replace function public.meta_merge() returns trigger
language plpgsql as $$
declare k text; v text; merged jsonb;
begin
  if tg_op = 'UPDATE' then
    merged := coalesce(old.sub_born, '{}'::jsonb);
    for k, v in select key, value from jsonb_each_text(coalesce(new.sub_born, '{}'::jsonb)) loop
      if not (merged ? k) or v < (merged ->> k) then
        merged := merged || jsonb_build_object(k, v);
      end if;
    end loop;
    new.sub_born := merged;

    if new.cats is null
       or (old.cats_updated_at is not null and (new.cats_updated_at is null or new.cats_updated_at < old.cats_updated_at)) then
      new.cats := old.cats;
      new.cats_updated_at := old.cats_updated_at;
    end if;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

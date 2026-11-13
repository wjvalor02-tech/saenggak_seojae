-- 생각서재 DB 스키마. Supabase 대시보드 → SQL Editor 에 통째로 붙여 넣고 Run.

-- 글: 본문·분류 등은 data(jsonb)에 통째로 둔다(앱 데이터 모델 그대로).
create table if not exists public.notes (
  id          text primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null,           -- 클라이언트가 고친 시각(충돌 시 최신 우선)
  deleted_at  timestamptz,                    -- 소프트 삭제(동기화용)
  synced_at   timestamptz not null default now(), -- 서버가 받은 시각(증분 동기화 기준)
  created_at  timestamptz not null default now()
);
create index if not exists notes_user_synced on public.notes (user_id, synced_at);

-- 갈래가 처음 생긴 날 등 작은 설정
create table if not exists public.meta (
  user_id    uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  sub_born   jsonb not null default '{}'::jsonb,
  synced_at  timestamptz not null default now()
);

-- AI 호출 수(하루 상한·사용량 기록)
create table if not exists public.ai_usage (
  user_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day      date not null default current_date,
  task     text not null,
  count    int  not null default 0,
  primary key (user_id, day, task)
);

-- 더 오래된 수정이 최신 내용을 덮어쓰지 못하게 + synced_at 갱신
create or replace function public.notes_keep_newest() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.user_id <> old.user_id then
      raise exception 'not allowed';
    end if;
    if new.updated_at < old.updated_at then
      return old;  -- 무시
    end if;
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists notes_keep_newest on public.notes;
create trigger notes_keep_newest before insert or update on public.notes
  for each row execute function public.notes_keep_newest();

-- 갈래 생일은 합집합(더 이른 날짜 우선)으로 병합
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
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;
drop trigger if exists meta_merge on public.meta;
create trigger meta_merge before insert or update on public.meta
  for each row execute function public.meta_merge();

-- 행 단위 보안: 본인 것만
alter table public.notes enable row level security;
alter table public.meta enable row level security;
alter table public.ai_usage enable row level security;

drop policy if exists "own notes" on public.notes;
create policy "own notes" on public.notes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own meta" on public.meta;
create policy "own meta" on public.meta for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "own usage read" on public.ai_usage;
create policy "own usage read" on public.ai_usage for select using (user_id = auth.uid());

-- AI 호출 수를 1 올리고 오늘 총합을 돌려준다(Edge Function에서 사용자 토큰으로 호출)
create or replace function public.bump_ai_usage(p_task text) returns int
language plpgsql security definer set search_path = public as $$
declare total int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into ai_usage (user_id, day, task, count) values (auth.uid(), current_date, p_task, 1)
  on conflict (user_id, day, task) do update set count = ai_usage.count + 1;
  select coalesce(sum(count), 0) into total from ai_usage where user_id = auth.uid() and day = current_date;
  return total;
end $$;
revoke all on function public.bump_ai_usage(text) from public, anon;
grant execute on function public.bump_ai_usage(text) to authenticated;

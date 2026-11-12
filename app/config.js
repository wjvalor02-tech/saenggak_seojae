// 서버 동기화 설정. 비워 두면 '이 기기에만 저장' 모드로 동작한다.
// Supabase 대시보드 → Project Settings → API 에서 복사한다.
// anon(public) 키는 공개돼도 되는 키다(행 단위 보안 RLS로 본인 글만 읽고 쓸 수 있음).
// AI 키(Gemini/Claude)는 절대 여기에 넣지 않는다 → Supabase Edge Function 비밀값으로만.
window.SEOJAE_CONFIG = {
  supabaseUrl: 'https://vxgxduggymkxtgfmcsvi.supabase.co',      // 예: 'https://abcdefgh.supabase.co'
  supabaseAnonKey: 'sb_publishable_yny4BMMN5QHa0XOoIZyS9A_EIRGQdV_',  // 예: 'eyJhbGciOi...'
};

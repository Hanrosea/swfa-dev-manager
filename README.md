# 마이비인프라 개발업무관리

부서 간 개발 일정, 사업·개발·품질 공수, 담당자와 진행률을 한 화면에서 공유하기 위한 Next.js 프로젝트입니다.

## 포함된 기능

- 연도·연월별 간트 차트와 프로젝트별 FW 일정 펼치기. 선택 기간과 겹치는 사업기간 또는 FW 일정(설계·개발·품질·배포)으로 조회하고, 일정 미정 건은 선택해 포함할 수 있습니다.
- 선택 기간과 화면 필터에 맞는 개발 내역·FW 일정을 엑셀(.xlsx)로 내보내기
- 개발명·고객사·지역 검색
- 구분·담당자·진행상태 필터 (진행중 0~99%, 완료 100%)
- 개발 건 상세 패널
- 신규 개발 등록
- FW별 지역·구분·버전·설계/개발/품질 기간과 진행사항, 프로젝트별 사업 총괄·설계·개발·품질·배포·사업 수행 공수(MD)
- FW 단계와 공수를 반영한 프로젝트 공정률
- 진행 중·완료·지연 건수 자동 집계
- `품질진행` FW 선택 및 품질 테스트 우선순위 관리
- 우선순위 카드 마우스 드래그 정렬 및 저장
- 이슈사항 상세 조회·수정 및 날짜별 활동기록 등록
- 프로젝트에서 가장 늦은 FW 품질 종료일 다음 평일(월~금)에 배포 예정일 자동 산정
- 확인창을 거친 개발 건 삭제
- 필요사항별 구분·상세내용·필요사유·진행일정·진행사항과 상세 화면의 필요사항·FW 상태 즉시 저장
- Supabase 이메일 로그인과 DB 저장
- Supabase 미설정 시 브라우저에 저장되는 데모 모드
- 데스크톱·태블릿·모바일 반응형 화면

## 실행 방법

Node.js 22 이상을 권장합니다.

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 환경변수가 없으면 데모 모드로 실행되고, 새로 등록한 내용은 해당 브라우저에 저장됩니다.

## Supabase 연결

1. Supabase에서 새 프로젝트를 만듭니다.
2. 신규 프로젝트는 SQL Editor에서 `supabase/schema.sql` 전체를 실행합니다.
   기존 v0.3 DB는 먼저 `supabase/migrations/20260810_qa_priority.sql`을 실행합니다.
   신규 및 기존 DB 모두 앱 배포 직전에 `supabase/migrations/20261124_firmware.sql`을 실행합니다. 전환 중에는 기존 화면에서 일정·우선순위 수정을 잠시 중단합니다.
   이슈 활동기록은 신규 및 기존 DB 모두 `supabase/migrations/20261124060659_issue_activities.sql`을 실행해 추가합니다.
   이어서 `supabase/migrations/20261124070617_development_requirements.sql`을 실행합니다. 기존 필요사항 메모는 상세내용 한 행으로 이관되며 진행사항은 직접 선택할 수 있습니다.
   이어서 다음 FW 일정 마이그레이션을 순서대로 실행합니다.
   1. `supabase/migrations/20261124123629_firmware_design_columns.sql`
   2. `supabase/migrations/20261124133802_firmware_schedule_rules.sql`
   3. `supabase/migrations/20261124133830_save_firmware_design_schedule.sql`
   4. `supabase/migrations/20261124133845_align_firmware_release_dates.sql`

   프로젝트 배포 공수는 `supabase/migrations/20261125013449_project_deployment_effort.sql`을 실행해 사업 수행 공수와 별도로 저장합니다.

   설계일정은 미정으로 시작하며, 자동 계산으로 교체한 기존 배포일은 `legacy_deployment_date`에 보관합니다.
3. Authentication의 Users 메뉴에서 사용할 이메일 계정을 만듭니다.
4. `.env.example`을 `.env.local`로 복사하고 값을 입력합니다.

```env
NEXT_PUBLIC_SUPABASE_URL=https://프로젝트주소.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=발급받은-anon-key
```

5. 개발 서버를 다시 실행하면 로그인 화면과 실제 DB 저장이 활성화됩니다.

일정 대시보드의 공정률은 가로로 스크롤해도 보이며, FW 진행사항과 프로젝트 공수를 바탕으로 자동 계산합니다. 우선순위에는 `품질진행` FW만 추가할 수 있습니다. FW를 삭제하거나 다른 상태로 바꾸면 해당 순위가 해제됩니다. 배포 일정과 담당자는 프로젝트 공통값입니다.

기존 프로젝트는 FW 한 행으로 전환하고 기존 개발·품질 일정과 상태, QA 순서를 이어받습니다. 원본 단계 기록은 보존합니다. FW 구분과 버전은 미지정으로 표시하며 수정 화면에서 채울 수 있습니다. 기존 사업·개발·품질·배포 공수는 각각 사업 총괄·개발·품질 테스트·사업 수행으로 이관하고, 분석 및 설계는 0 MD로 시작합니다.

## 주요 파일

```text
app/development-manager.tsx  대시보드 기능과 화면
app/globals.css              전체 디자인과 반응형 스타일
lib/mock-data.ts             데모 모드의 초기 개발 데이터
lib/supabase.ts              Supabase 연결 설정
lib/types.ts                 개발·일정 타입
supabase/schema.sql          DB 테이블·인덱스·RLS 정책
```

## 운영 전 확인사항

- 현재 RLS 정책은 로그인한 사용자가 전체 개발 건을 함께 수정하는 부서 공용 방식입니다.
- 관리자/PM/담당자/조회자별 세부 권한은 `profiles` 역할 테이블을 추가해 정책을 나누면 됩니다.
- 첨부파일은 초기에는 사내 공유폴더 URL을 저장하는 방식을 권장합니다.
- 운영 배포 시 Supabase 이메일 확인 설정과 비밀번호 정책을 점검하세요.

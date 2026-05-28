# SmileShark Todo App

AWS 클라우드 위에서 운영되는 Todo List 웹 애플리케이션입니다. 사용자 인증은 **AWS Cognito**로 처리합니다.

## 아키텍처

```
사용자
  ↓ HTTPS  (psj0514.site)
CloudFront
  ├── psj0514.site/                → 정적 랜딩 페이지 (S3)
  └── (X-CloudFront-Auth 헤더로 ALB 직접 접근 차단)
        ↓
      ALB (Application Load Balancer)
        ├── /todoapp/*       → WEB (ECS)  : 정적 프론트엔드(index.html) 서빙
        ├── /todoapp/api/*   → WAS (ECS)  : REST API + RDS(MySQL) 연동
        └── grafana.psj0514.site → 모니터링 (Grafana)

인증:  AWS Cognito User Pool (Hosted UI)  ── WAS가 발급된 액세스 토큰을 검증
```

- **랜딩**: S3에 호스팅되는 정적 소개 페이지. CloudFront로 서빙 (`psj0514.site/`)
- **WEB**: 프론트엔드 서버(Node.js + Express). `public/index.html`을 서빙 (`psj0514.site/todoapp/`)
- **WAS**: 백엔드 서버(Node.js + Express). Todo CRUD API 제공 및 RDS(MySQL) 연동 (`psj0514.site/todoapp/api/`)
- **인증**: AWS Cognito User Pool + Hosted UI. WAS는 비밀번호를 다루지 않고 Cognito가 발급한 토큰만 검증
- **RDS**: MySQL 데이터베이스. WAS가 시작 시 DB 및 테이블 자동 생성/마이그레이션
- **모니터링**: 각 서비스가 `/metrics`로 Prometheus 지표를 노출하고 Grafana에서 시각화
- **ECR / ECS**: Docker 이미지 저장소 및 컨테이너 오케스트레이션 (`psj-project-ecs-cluster`)

## 인증 (AWS Cognito)

로그인/회원가입/비밀번호 관리는 모두 **AWS Cognito**가 담당합니다. 앱은 비밀번호를 저장하지 않습니다.

```
[앱] "로그인/회원가입" 버튼 클릭
   └─▶ Cognito Hosted UI로 리다이렉트  (Authorization Code + PKCE + state)
          └─▶ 로그인/가입 처리 (비밀번호·이메일 인증·재설정 모두 Cognito가 수행)
                 └─▶ 인가 코드와 함께 /todoapp/ 로 복귀
                        └─▶ 앱이 코드를 토큰으로 교환 → 액세스 토큰 저장
                               └─▶ API 호출 시 Authorization: Bearer <access_token>
```

- **프론트엔드**: OAuth 2.0 Authorization Code + PKCE 방식. CSRF 방어용 `state` 파라미터 검증 포함
- **WAS**: `aws-jwt-verify`로 Cognito 액세스 토큰을 검증(공개키 JWKS 자동 조회). 토큰의 `sub`(UUID)로 사용자를 식별하고 데이터를 격리
- **사용자 식별자**: Cognito `sub`. `todos.user_id`에 이 값을 저장 (비밀번호 등 계정 정보는 Cognito User Pool에만 존재)

## 프로젝트 구조

```
todoapp/
├── .github/
│   └── workflows/
│       └── build.yml       # CI/CD 파이프라인
├── landing/                # 정적 랜딩 페이지 (S3 + CloudFront)
│   ├── index.html
│   ├── style.css
│   └── script.js
├── web/
│   ├── server.js           # Express 정적 파일 서버
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html      # Todo List UI + Cognito 로그인 연동
└── was/
    ├── server.js           # Express REST API 서버 (Cognito 토큰 검증)
    ├── package.json
    └── Dockerfile
```

## 라우팅 (경로 접두사)

CloudFront → ALB 경로 기반 라우팅을 사용하며, 앱은 `/todoapp` 접두사 아래에서 서빙됩니다. ALB는 접두사를 제거하지 않고 그대로 전달하므로, 프론트엔드 요청 경로와 WAS 라우트 모두 `/todoapp/...`을 포함합니다.

| 경로 | 대상 |
|------|------|
| `psj0514.site/` | 랜딩 (S3) |
| `psj0514.site/todoapp/` | WEB 서비스 |
| `psj0514.site/todoapp/api/*` | WAS 서비스 |

> ALB 리스너는 `X-CloudFront-Auth` 커스텀 헤더를 검사해 **CloudFront를 거친 요청만** 허용합니다 (ALB 직접 접근 차단).

## API

모든 `/todoapp/api/todos*` 엔드포인트는 **인증 필요** (`Authorization: Bearer <Cognito access token>`).

| Method | Path | 인증 | 설명 |
|--------|------|------|------|
| GET | `/todoapp/api/health` | - | 헬스체크 |
| GET | `/todoapp/api/todos` | 필요 | 로그인 사용자의 Todo 목록 조회 |
| POST | `/todoapp/api/todos` | 필요 | Todo 생성 |
| PUT | `/todoapp/api/todos/:id` | 필요 | Todo 완료 상태 변경 |
| DELETE | `/todoapp/api/todos/:id` | 필요 | Todo 삭제 |

## 데이터베이스

WAS가 시작 시 데이터베이스와 테이블을 자동 생성하며, 기존 배포에 대한 마이그레이션도 수행합니다.

- **`todos`**: `id`, `user_id`(Cognito `sub`, VARCHAR), `title`, `done`, `created_at`
- 사용자 계정/비밀번호는 DB에 저장하지 않습니다 (Cognito User Pool이 관리)

## CI/CD

`main` 브랜치에 push하면 GitHub Actions가 변경된 영역을 감지해 자동 배포합니다.

```
코드 push (main)
  → 변경 감지 (landing / web / was)
  → landing: S3 동기화 + CloudFront 캐시 무효화
  → web/was: Docker 이미지 빌드(SHA 태그) → ECR push
             → Task Definition 새 revision 등록 → ECS 서비스 업데이트
```

- `landing/**` 변경 시 → `deploy-landing` 잡 (S3 + CloudFront)
- `web/**` 변경 시 → `deploy-web` 잡 (ECR + ECS)
- `was/**` 변경 시 → `deploy-was` 잡 (ECR + ECS)
- AWS 인증은 GitHub Secrets(`AWS_ROLE_ARN`)를 통한 **OIDC** 방식 사용 (액세스 키 미사용)

## 환경변수

WAS는 아래 환경변수가 ECS Task Definition에 설정되어 있어야 합니다. (없으면 시작 시 종료)

| 변수명 | 설명 | 출처 |
|--------|------|------|
| `COGNITO_USER_POOL_ID` | Cognito 사용자 풀 ID | 일반 환경변수 |
| `COGNITO_CLIENT_ID` | Cognito 앱 클라이언트 ID | 일반 환경변수 |
| `DB_HOST` | RDS 엔드포인트 | 일반 환경변수 |
| `DB_PORT` | MySQL 포트 (기본값: 3306) | 일반 환경변수 |
| `DB_NAME` | 데이터베이스 이름 | 일반 환경변수 |
| `DB_USER` | DB 사용자 | Secrets Manager |
| `DB_PASSWORD` | DB 패스워드 | Secrets Manager |
| `PORT` | 서버 포트 (기본값: 3000) | 일반 환경변수 |

- Cognito ID·도메인·앱 클라이언트 ID는 비밀이 아닌 공개 식별자이며, 프론트엔드(`web/public/index.html`)에도 포함됩니다.
- `DB_USER`, `DB_PASSWORD`는 AWS Secrets Manager에서 가져옵니다. 하드코딩 금지.

> WAS가 Cognito 공개키(JWKS, `cognito-idp.<region>.amazonaws.com`)를 외부 HTTPS로 조회하므로, 프라이빗 서브넷에 있을 경우 NAT 게이트웨이 등 아웃바운드 경로가 필요합니다.

## 모니터링

- 각 서비스(`web`, `was`)는 `express-prom-bundle`로 `/metrics` 엔드포인트에 Prometheus 지표를 노출합니다 (`app`, `component` 라벨 포함).
- 요청 로그는 구조화된 JSON 형식으로 출력됩니다 (`morgan`).
- Grafana 대시보드: `grafana.psj0514.site`

## 트러블슈팅 기록

### WAS 컨테이너 미동작 (`Essential container in task exited`)

**원인**
1. `was/server.js`가 `initDB` 함수만 남기고 나머지 코드(require, express 설정, API 라우트, app.listen)가 모두 유실됨
2. ECS 서비스가 ECR에 존재하지 않는 이미지 태그를 가진 구버전 Task Definition(revision 4)을 바라보고 있었음

**해결**
1. `was/server.js`를 초기 커밋 기준으로 복구하고 `CREATE DATABASE IF NOT EXISTS` 로직 추가
2. ECS 서비스의 Task Definition을 최신 revision으로 수동 업데이트 후 Force new deployment

### ECS는 ECR 이미지 push를 자동 감지하지 않음

ECR에 이미지를 push해도 ECS는 자동으로 재배포하지 않습니다. Task Definition 업데이트 → 서비스 업데이트 과정이 필요하며, 이를 `build.yml`이 자동으로 처리합니다.

### Cognito 전환 시 WAS 시작 실패

Cognito로 전환한 뒤 `COGNITO_USER_POOL_ID` / `COGNITO_CLIENT_ID` 환경변수를 Task Definition에 추가하지 않으면 WAS가 시작 시 종료됩니다. 배포 전 환경변수를 먼저 설정해야 합니다.

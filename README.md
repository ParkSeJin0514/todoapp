# SmileShark Todo App

AWS ECS 위에서 운영되는 Todo List 웹 애플리케이션입니다.

## 아키텍처

```
사용자
  ↓
ALB (Application Load Balancer)
  ├── WEB (EC2, Node.js + Express)  →  정적 파일 서빙 (HTML/CSS/JS)
  └── WAS (EC2, Node.js + Express)  →  REST API + MySQL(RDS) 연동
```

- **WEB**: 프론트엔드 서버. `public/index.html`을 서빙하고 WAS API를 호출
- **WAS**: 백엔드 서버. Todo CRUD API 제공 및 RDS(MySQL) 연동
- **RDS**: MySQL 데이터베이스. WAS가 시작 시 DB 및 테이블 자동 생성
- **ECR**: Docker 이미지 저장소 (`todoapp/web`, `todoapp/was`)
- **ECS**: EC2 기반 컨테이너 오케스트레이션 (`psj-project-ecs-cluster`)

## 프로젝트 구조

```
smileshark/
├── .github/
│   └── workflows/
│       └── build.yml       # CI/CD 파이프라인
├── web/
│   ├── server.js           # Express 정적 파일 서버
│   ├── package.json
│   ├── Dockerfile
│   └── public/
│       └── index.html      # Todo List UI
└── was/
    ├── server.js           # Express REST API 서버
    ├── package.json
    └── Dockerfile
```

## API

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/health` | 헬스체크 |
| GET | `/api/todos` | Todo 목록 조회 |
| POST | `/api/todos` | Todo 생성 |
| PUT | `/api/todos/:id` | Todo 완료 상태 변경 |
| DELETE | `/api/todos/:id` | Todo 삭제 |

## CI/CD

`main` 브랜치에 push하면 GitHub Actions가 자동으로 실행됩니다.

```
코드 push (main)
  → 변경된 서비스 감지 (web / was)
  → Docker 이미지 빌드 (SHA 태그)
  → ECR push
  → Task Definition 새 revision 등록
  → ECS 서비스 업데이트 → 자동 배포
```

- `web/**` 변경 시 → `deploy-web` 잡만 실행
- `was/**` 변경 시 → `deploy-was` 잡만 실행
- AWS 인증은 GitHub Secrets(`AWS_ROLE_ARN`)를 통한 OIDC 방식 사용

## 환경변수

WAS는 아래 환경변수가 ECS Task Definition에 설정되어 있어야 합니다.

| 변수명 | 설명 |
|--------|------|
| `DB_HOST` | RDS 엔드포인트 |
| `DB_PORT` | MySQL 포트 (기본값: 3306) |
| `DB_NAME` | 데이터베이스 이름 |
| `DB_USER` | DB 사용자 (Secrets Manager) |
| `DB_PASSWORD` | DB 패스워드 (Secrets Manager) |
| `PORT` | 서버 포트 (기본값: 3000) |

`DB_USER`, `DB_PASSWORD`는 AWS Secrets Manager에서 가져옵니다. 하드코딩 금지.

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
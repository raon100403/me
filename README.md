# mypage

Cloudflare Workers Static Assets로 호스팅하는 정적 사이트입니다. 별도 빌드 없이
`wrangler.jsonc`의 `assets.directory`에서 HTML, CSS, JavaScript를 제공합니다.

## 로컬 확인 및 배포

Node.js와 npm이 설치된 환경에서 프로젝트 루트에서 실행합니다.

```sh
npx wrangler@4 dev
```

배포 설정을 확인하거나 Cloudflare에 배포하려면 다음 명령을 사용합니다.

```sh
npx wrangler@4 deploy --dry-run
npx wrangler@4 login
npx wrangler@4 deploy
```

Worker 이름은 `mypage`입니다. 기존 Worker에 연결한다면 `wrangler.jsonc`의 `name`을
해당 이름과 일치시키세요. `/`, `/bike/`, `/bike/privacy/`를 제공하며, 없는 경로는
404로 응답합니다.

Cloudflare에서 Git 저장소를 연결해 Workers Builds를 사용한다면 빌드 명령은 비워두고,
배포 명령은 `npx wrangler@4 deploy`, 루트 디렉터리는 저장소 루트로 설정합니다.
사용자 지정 도메인은 배포 후 Worker의 **Settings → Domains & Routes**에서 연결합니다.

`.assetsignore`에 명시된 공개 파일만 업로드합니다. 이미지나 페이지를 추가하면
해당 파일과 상위 디렉터리도 이 목록에 추가하세요.

## 음악 이퀄라이저

음표 버튼을 누르면 작은 플레이어로 펼쳐지고, 재생하는 동안 점 배경이 30밴드 그래픽
이퀄라이저로 바뀝니다. 막대는 재생 중인 소리를 Web Audio로 FFT 분석한 실제 스펙트럼이며
(`music.js`), 별도 권한 없이 모든 최신 브라우저에서 동작합니다.

곡을 추가하려면 음원 파일을 `music/` 폴더에 넣고 `music/tracks.json`에 적습니다. 목록
순서대로 재생됩니다.

```json
[
  { "title": "곡 제목", "file": "song.mp3" },
  "another-song.mp3"
]
```

- `file`은 `music/` 기준 경로입니다. `title`을 생략하면 파일 이름이 제목이 됩니다.
- mp3, m4a(AAC), ogg, wav처럼 브라우저가 재생할 수 있는 형식을 쓰고, 파일 하나는
  Workers Static Assets 제한인 25MiB 이하여야 합니다.
- 방문자는 폴더 버튼으로 자기 기기의 음원 파일을 열어 같은 이퀄라이저로 들을 수 있습니다.
  이 파일은 브라우저 안에서만 재생되고 업로드되지 않습니다.

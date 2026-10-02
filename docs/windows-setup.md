# 윈도우 PC 설치·운영 가이드

구성: **윈도우 PC 1대(서버) + 개인 폰 2대**, 모두 **Tailscale** 사설망으로 연결.
서버를 인터넷에 직접 열지 않으므로 공유기 포트포워딩이 필요 없고, Tailscale에 등록한 기기만 접속할 수 있습니다.

## 1. 서버 PC 준비
1. Node.js **22 LTS 이상**을 https://nodejs.org 에서 설치합니다.
2. 이 프로젝트 폴더를 PC에 둡니다. (예: `C:\manpower`)
3. 폴더에서 `start.bat`을 더블클릭합니다.
   - 처음 한 번 관리자 계정 `admin`의 **임시 비밀번호**가 창에 출력됩니다. 적어 두고 로그인 후 바로 변경하세요.
   - 이 PC에서 `https`가 아니라 `http://127.0.0.1:3000`으로 열어 확인할 때는 쿠키가 Secure라 로그인이 안 될 수 있습니다. 확인은 아래 3번 이후 HTTPS 주소로 하세요.

## 2. Tailscale 설치 (PC + 폰 2대)
1. https://tailscale.com 에서 **회사용 계정 1개**(구글/마이크로소프트 로그인)로 가입합니다. 개인 3대 이하는 무료입니다.
2. 서버 PC에 Tailscale을 설치하고 로그인합니다.
3. 폰 2대에도 Tailscale 앱을 설치하고 **같은 계정**으로 로그인합니다. (직원 개인 계정이 아니라 회사 계정 하나에 폰을 등록하는 방식입니다.)
4. 관리 콘솔(https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다.

## 3. HTTPS로 서비스 열기
서버 PC에서 관리자 권한 PowerShell로 한 번만 실행합니다.

```powershell
tailscale serve --bg 3000
tailscale serve status
```

`status`에 나오는 `https://<PC이름>.<tailnet이름>.ts.net` 주소가 접속 주소입니다.
폰에서 Tailscale을 켠 상태로 이 주소를 열면 로그인 화면이 나옵니다. (홈 화면에 추가해 두면 앱처럼 쓸 수 있습니다.)

> 인터넷 전체에 공개하는 `tailscale funnel`은 **절대 쓰지 마세요.** 이 앱은 Tailscale에 등록한 기기 전용입니다.

## 4. 부팅하면 자동 실행
작업 스케줄러에 로그인 시 자동 실행을 등록합니다. (경로는 실제 위치로 바꾸세요)

```powershell
schtasks /Create /TN "ManpowerServer" /TR "C:\manpower\start.bat" /SC ONLOGON /RL HIGHEST /F
```

PC 재부팅 후 로그인하면 서버가 자동으로 켜집니다. 절전 모드로 들어가면 폰에서 접속이 안 되니, 윈도우 설정에서 **절전 안 함**으로 바꾸세요.

## 5. 매일 자동 백업
```powershell
schtasks /Create /TN "ManpowerBackup" /TR "C:\manpower\backup.bat" /SC DAILY /ST 22:00 /F
```

- 백업은 `data\backups\`에 날짜별 파일로 쌓이고 **최근 30개**만 남습니다. (`BACKUP_KEEP`으로 조정)
- **같은 PC 안의 백업은 PC가 고장 나면 같이 사라집니다.** 주 1회 정도 `data\backups` 폴더를 외장 USB에 복사하세요. (개인정보가 있으니 USB는 회사에서 보관)
- 복구: 서버를 끄고 백업 파일을 `data\manpower.db`로 복사한 뒤 다시 시작합니다.

## 6. 직원 추가·퇴사
- 폰 사용자 계정은 앱의 **사용자** 탭에서 만듭니다. 권한은 입력 담당은 `입력`, 조회만 하면 `열람`.
- 퇴사하거나 폰을 잃어버리면: 앱에서 해당 사용자를 **중지**하고, Tailscale 관리 콘솔의 Machines에서 그 폰을 **삭제**하세요. 둘 다 하면 접근이 완전히 막힙니다.

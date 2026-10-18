/**
 * Google Android Key Attestation 信任锚（内置固定，不做运行时拉取）。
 *
 * 为什么内置而不是每次去 `https://android.googleapis.com/attestation/root` 取：
 * - 服务端要能在 Google 侧域名被墙 / 抖动时继续判定（国内可达性风险，见
 *   `tasks/cee-anticheat-plan-2026-10-19.md` P3.2 坑 1、坑 2）；
 * - 验证结论必须可复核：固定字节后，任何人重跑同一份常量都能得到同一个是否值，
 *   运行时拉取等于把信任锚交给一次 HTTP 响应。
 *
 * 为什么必须**同时**放两个硬件根：Google 于 2026-02 启用新根（ECDSA P-384），
 * RKP 设备在 2026-04-10 完成切换；工厂预置密钥的老设备仍用旧根且永不轮换。
 * 只放旧根会拒掉几乎所有新设备，只放新根会拒掉老机型。
 *
 * 字节来源（2026-10-19 记录，逐字节取自 Google 官方参考验证库，非手工转写）：
 * - 两个硬件根：`https://raw.githubusercontent.com/android/keyattestation/main/roots.json`
 *   （与 `https://android.googleapis.com/attestation/root` 当前下发的是同一份新根，
 *   旧根不在该下载端点里——端点只回一份，所以旧根只能靠仓库固定）。
 * - 两个软件根：`https://raw.githubusercontent.com/android/keyattestation/main/src/main/kotlin/SoftwareRoot.kt`
 *   （AOSP 生成源：`https://android.googlesource.com/platform/system/core/+/main/trusty/keymaster/set_attestation_key/keymaster_soft_attestation_keys.xml`）。
 *   无 TEE 的低端机 `attestationSecurityLevel = Software`，其链只能链到软件根；
 *   不放进信任库就会把「能力不足」误判成「根不受信」，与分档口径冲突。
 *
 * 更新方式：只改本文件，把新 PEM 追加进对应数组，并在注释里写清来源、生效时间与指纹。
 * 指纹（SHA-256，DER）是复核锚点：重新下载后算出的值必须与这里一致，否则说明来源被替换。
 */

/**
 * 硬件根 · 旧（工厂预置 fleet）。
 *
 * Subject/Issuer: `serialNumber=f92009e853b6b045`（自签，无 CN——按 DN 字符串匹配不可靠，
 * 验证侧只做 DER 逐字节比对与公钥验签）。
 * 公钥 RSA-4096；有效期 2022-03-20 → 2042-03-15；序列号 F1C172A699EAF51D；
 * SHA-256 `cedb1cb6dc896ae5ec797348bce9286753c2b38ee71ce0fbe34a9a1248800dfc`。
 */
const ROOT_HARDWARE_RSA_PEM = `-----BEGIN CERTIFICATE-----
MIIFHDCCAwSgAwIBAgIJAPHBcqaZ6vUdMA0GCSqGSIb3DQEBCwUAMBsxGTAXBgNV
BAUTEGY5MjAwOWU4NTNiNmIwNDUwHhcNMjIwMzIwMTgwNzQ4WhcNNDIwMzE1MTgw
NzQ4WjAbMRkwFwYDVQQFExBmOTIwMDllODUzYjZiMDQ1MIICIjANBgkqhkiG9w0B
AQEFAAOCAg8AMIICCgKCAgEAr7bHgiuxpwHsK7Qui8xUFmOr75gvMsd/dTEDDJdS
Sxtf6An7xyqpRR90PL2abxM1dEqlXnf2tqw1Ne4Xwl5jlRfdnJLmN0pTy/4lj4/7
tv0Sk3iiKkypnEUtR6WfMgH0QZfKHM1+di+y9TFRtv6y//0rb+T+W8a9nsNL/ggj
nar86461qO0rOs2cXjp3kOG1FEJ5MVmFmBGtnrKpa73XpXyTqRxB/M0n1n/W9nGq
C4FSYa04T6N5RIZGBN2z2MT5IKGbFlbC8UrW0DxW7AYImQQcHtGl/m00QLVWutHQ
oVJYnFPlXTcHYvASLu+RhhsbDmxMgJJ0mcDpvsC4PjvB+TxywElgS70vE0XmLD+O
JtvsBslHZvPBKCOdT0MS+tgSOIfga+z1Z1g7+DVagf7quvmag8jfPioyKvxnK/Eg
sTUVi2ghzq8wm27ud/mIM7AY2qEORR8Go3TVB4HzWQgpZrt3i5MIlCaY504LzSRi
igHCzAPlHws+W0rB5N+er5/2pJKnfBSDiCiFAVtCLOZ7gLiMm0jhO2B6tUXHI/+M
RPjy02i59lINMRRev56GKtcd9qO/0kUJWdZTdA2XoS82ixPvZtXQpUpuL12ab+9E
aDK8Z4RHJYYfCT3Q5vNAXaiWQ+8PTWm2QgBR/bkwSWc+NpUFgNPN9PvQi8WEg5Um
AGMCAwEAAaNjMGEwHQYDVR0OBBYEFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMB8GA1Ud
IwQYMBaAFDZh4QB8iAUJUYtEbEf/GkzJ6k8SMA8GA1UdEwEB/wQFMAMBAf8wDgYD
VR0PAQH/BAQDAgIEMA0GCSqGSIb3DQEBCwUAA4ICAQB8cMqTllHc8U+qCrOlg3H7
174lmaCsbo/bJ0C17JEgMLb4kvrqsXZs01U3mB/qABg/1t5Pd5AORHARs1hhqGIC
W/nKMav574f9rZN4PC2ZlufGXb7sIdJpGiO9ctRhiLuYuly10JccUZGEHpHSYM2G
tkgYbZba6lsCPYAAP83cyDV+1aOkTf1RCp/lM0PKvmxYN10RYsK631jrleGdcdkx
oSK//mSQbgcWnmAEZrzHoF1/0gso1HZgIn0YLzVhLSA/iXCX4QT2h3J5z3znluKG
1nv8NQdxei2DIIhASWfu804CA96cQKTTlaae2fweqXjdN1/v2nqOhngNyz1361mF
mr4XmaKH/ItTwOe72NI9ZcwS1lVaCvsIkTDCEXdm9rCNPAY10iTunIHFXRh+7KPz
lHGewCq/8TOohBRn0/NNfh7uRslOSZ/xKbN9tMBtw37Z8d2vvnXq/YWdsm1+JLVw
n6yYD/yacNJBlwpddla8eaVMjsF6nBnIgQOf9zKSe06nSTqvgwUHosgOECZJZ1Eu
zbH4yswbt02tKtKEFhx+v+OTge/06V+jGsqTWLsfrOCNLuA8H++z+pUENmpqnnHo
vaI47gC+TNpkgYGkkBT6B/m/U01BuOBBTzhIlMEZq9qkDWuM2cA5kW5V3FJUcfHn
w1IdYIg2Wxg7yHcQZemFQg==
-----END CERTIFICATE-----
`;

/**
 * 硬件根 · 新（RKP fleet，2026-02 起设备开始上报、2026-04-10 起独占）。
 *
 * Subject/Issuer: `CN=Key Attestation CA1, OU=Android, O=Google LLC, C=US`（自签）。
 * 公钥 ECDSA P-384；有效期 2025-07-17 → 2035-07-15；
 * 序列号 84A9D0297B0EB58AE7FF0E80DE760605；
 * SHA-256 `6d9db4ce6c5c0b293166d08986e05774a8776ceb525d9e4329520de12ba4bcc0`。
 */
const ROOT_HARDWARE_ECDSA_PEM = `-----BEGIN CERTIFICATE-----
MIICIjCCAaigAwIBAgIRAISp0Cl7DrWK5/8OgN52BgUwCgYIKoZIzj0EAwMwUjEc
MBoGA1UEAwwTS2V5IEF0dGVzdGF0aW9uIENBMTEQMA4GA1UECwwHQW5kcm9pZDET
MBEGA1UECgwKR29vZ2xlIExMQzELMAkGA1UEBhMCVVMwHhcNMjUwNzE3MjIzMjE4
WhcNMzUwNzE1MjIzMjE4WjBSMRwwGgYDVQQDDBNLZXkgQXR0ZXN0YXRpb24gQ0Ex
MRAwDgYDVQQLDAdBbmRyb2lkMRMwEQYDVQQKDApHb29nbGUgTExDMQswCQYDVQQG
EwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABCPaI3FO3z5bBQo8cuiEas4HjqCt
G/mLFfRT0MsIssPBEEU5Cfbt6sH5yOAxqEi5QagpU1yX4HwnGb7OtBYpDTB57uH5
Eczm34A5FNijV3s0/f0UPl7zbJcTx6xwqMIRq6NCMEAwDwYDVR0TAQH/BAUwAwEB
/zAOBgNVHQ8BAf8EBAMCAQYwHQYDVR0OBBYEFFIyuyz7RkOb3NaBqQ5lZuA0QepA
MAoGCCqGSM49BAMDA2gAMGUCMETfjPO/HwqReR2CS7p0ZWoD/LHs6hDi422opifH
EUaYLxwGlT9SLdjkVpz0UUOR5wIxAIoGyxGKRHVTpqpGRFiJtQEOOTp/+s1GcxeY
uR2zh/80lQyu9vAFCj6E4AXc+osmRg==
-----END CERTIFICATE-----
`;

/**
 * 软件根 · ECDSA P-256（`CN=Android Keystore Software Attestation Root`）。
 *
 * 只用于「链可信但 SecurityLevel = Software」的降级判定，不构成硬件证明。
 * 有效期 2016-01-11 → 2036-01-06；序列号 A2059ED10E435B57；
 * SHA-256 `51d496ad4664190fbdaf1ad987278efa35d6fbf52e50a9c34ded8395477ede5c`。
 */
const ROOT_SOFTWARE_ECDSA_PEM = `-----BEGIN CERTIFICATE-----
MIICizCCAjKgAwIBAgIJAKIFntEOQ1tXMAoGCCqGSM49BAMCMIGYMQswCQYDVQQG
EwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmll
dzEVMBMGA1UECgwMR29vZ2xlLCBJbmMuMRAwDgYDVQQLDAdBbmRyb2lkMTMwMQYD
VQQDDCpBbmRyb2lkIEtleXN0b3JlIFNvZnR3YXJlIEF0dGVzdGF0aW9uIFJvb3Qw
HhcNMTYwMTExMDA0MzUwWhcNMzYwMTA2MDA0MzUwWjCBmDELMAkGA1UEBhMCVVMx
EzARBgNVBAgMCkNhbGlmb3JuaWExFjAUBgNVBAcMDU1vdW50YWluIFZpZXcxFTAT
BgNVBAoMDEdvb2dsZSwgSW5jLjEQMA4GA1UECwwHQW5kcm9pZDEzMDEGA1UEAwwq
QW5kcm9pZCBLZXlzdG9yZSBTb2Z0d2FyZSBBdHRlc3RhdGlvbiBSb290MFkwEwYH
KoZIzj0CAQYIKoZIzj0DAQcDQgAE7l1ex+HA220Dpn7mthvsTWpdamguD/9/SQ59
dx9EIm29sa/6FsvHrcV30lacqrewLVQBXT5DKyqO107sSHVBpKNjMGEwHQYDVR0O
BBYEFMit6XdMRcOjzw0WEOR5QzohWjDPMB8GA1UdIwQYMBaAFMit6XdMRcOjzw0W
EOR5QzohWjDPMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgKEMAoGCCqG
SM49BAMCA0cAMEQCIDUho++LNEYenNVg8x1YiSBq3KNlQfYNns6KGYxmSGB7AiBN
C/NR2TB8fVvaNTQdqEcbY6WFZTytTySn502vQX3xvw==
-----END CERTIFICATE-----
`;

/**
 * 软件根 · RSA-1024（与上一个同源，AOSP 早批软件 attestation 键）。
 *
 * Subject 只有 `O=Google, Inc., OU=Android, ...`（无 CN）。1024 位密钥本身偏弱，
 * 但它只服务于 Software 档（已经降级），不进入 trusted 判定路径。
 * 有效期 2016-01-04 → 2035-12-30；序列号 FF94D9DD9F07C80C；
 * SHA-256 `4e42730efd521b21d77b109b7532a0b664ddfefc73e129111936200c5e58cce0`。
 */
const ROOT_SOFTWARE_RSA_PEM = `-----BEGIN CERTIFICATE-----
MIICpzCCAhCgAwIBAgIJAP+U2d2fB8gMMA0GCSqGSIb3DQEBCwUAMGMxCzAJBgNV
BAYTAlVTMRMwEQYDVQQIDApDYWxpZm9ybmlhMRYwFAYDVQQHDA1Nb3VudGFpbiBW
aWV3MRUwEwYDVQQKDAxHb29nbGUsIEluYy4xEDAOBgNVBAsMB0FuZHJvaWQwHhcN
MTYwMTA0MTIzMTA4WhcNMzUxMjMwMTIzMTA4WjBjMQswCQYDVQQGEwJVUzETMBEG
A1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmlldzEVMBMGA1UE
CgwMR29vZ2xlLCBJbmMuMRAwDgYDVQQLDAdBbmRyb2lkMIGfMA0GCSqGSIb3DQEB
AQUAA4GNADCBiQKBgQCia63rbi5EYe/VDoLmt5TRdSMfd5tjkWP/96r/C3JHTsAs
Q+wzfNes7UA+jCigZtX3hwszl94OuE4TQKuvpSe/lWmgMdsGUmX4RFlXYfC78hdL
t0GAZMAoDo9Sd47b0ke2RekZyOmLw9vCkT/X11DEHTVm+Vfkl5YLCazOkjWFmwID
AQABo2MwYTAdBgNVHQ4EFgQUKfrxrMxN0kyWQCd1trDpMuUH/i4wHwYDVR0jBBgw
FoAUKfrxrMxN0kyWQCd1trDpMuUH/i4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8B
Af8EBAMCAoQwDQYJKoZIhvcNAQELBQADgYEAT3LzNlmNDsG5dFsxWfbwjSVJMJ6j
HBwp0kUtILlNX2S06IDHeHqcOd6os/W/L3BfRxBcxebrTQaZYdKumgf/93y4q+uc
DyQHXrF/unlx/U1bnt8Uqf7f7XzAiF343ZtkMlbVNZriE/mPzsF83O+kqrJVw4Op
Lvtc9mL1J1IXvmM=
-----END CERTIFICATE-----
`;

/** 能进入 `trusted` 档的根：只认硬件链，软件根不具备硬件证明资格。 */
export const ANDROID_HARDWARE_ATTESTATION_ROOT_PEMS: readonly string[] = [
  ROOT_HARDWARE_RSA_PEM,
  ROOT_HARDWARE_ECDSA_PEM,
];

/** 只能到 `degraded` 档的根：`SecurityLevel = Software` 的链会链到这里。 */
export const ANDROID_SOFTWARE_ATTESTATION_ROOT_PEMS: readonly string[] = [
  ROOT_SOFTWARE_ECDSA_PEM,
  ROOT_SOFTWARE_RSA_PEM,
];

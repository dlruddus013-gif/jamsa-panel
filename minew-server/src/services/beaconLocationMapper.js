/**
 * major → 부서/그룹 매핑 (사람 식별 규칙).
 * 코드 하드코딩 X — 추후 DB로 옮기기 쉽도록 상수 파일로 분리.
 */
const MAJOR_TO_DEPT = {
  101: "관리부",
  102: "시설부",
  103: "안내/매표",
  104: "체험/교육",
  105: "식당/매점",
  201: "내국인 단체",
  202: "외국인 단체",
  301: "장비/비품",
};

function describeIdentity({ major, minor, namespace, instance, beacon_mac }) {
  if (major != null) {
    const dept = MAJOR_TO_DEPT[major] || `미정 그룹(${major})`;
    return { kind: "ibeacon", department: dept, label: `${dept} ${minor != null ? `${minor}번 태그` : ""}`.trim() };
  }
  if (namespace && instance) {
    return { kind: "eddystone_uid", department: "Eddystone", label: `UID ${instance.slice(-6)}` };
  }
  if (beacon_mac && beacon_mac !== "unknown") {
    return { kind: "mac", department: "미등록", label: `MAC ${beacon_mac.slice(-6)}` };
  }
  return { kind: "unknown", department: "미등록", label: "미식별" };
}

module.exports = { MAJOR_TO_DEPT, describeIdentity };

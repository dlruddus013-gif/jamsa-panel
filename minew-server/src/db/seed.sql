-- 샘플 태그: 관리부 1번 (관리자 테스트용)
-- 동일 비콘이 TLM/UID/iBeacon 3개 형태로 신호 송출 → 모두 같은 사람으로 묶기
INSERT OR IGNORE INTO beacon_tags
  (tag_id, owner_type, owner_name, department, role, beacon_mac, uuid, major, minor, namespace, instance, is_active)
VALUES
  ('TAG-0001', 'staff', '관리부 1번', '관리부', '직원',
   'c300002a772a', 'e2c56db5dffb48d2b060d0f5a71096e0', 101, 1,
   '00112233445566778899', '000000000001', 1);

-- alias 3개: 같은 사람의 3개 식별자
INSERT OR IGNORE INTO tag_aliases (tag_id, alias_type, alias_value) VALUES
  ('TAG-0001', 'beacon_mac',    'c300002a772a'),
  ('TAG-0001', 'ibeacon',       'e2c56db5dffb48d2b060d0f5a71096e0:101:1'),
  ('TAG-0001', 'eddystone_uid', '00112233445566778899:000000000001');

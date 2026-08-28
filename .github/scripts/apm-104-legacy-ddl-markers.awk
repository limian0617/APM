function fail(message) { waiting=0; print message > "/dev/stderr"; exit 64 }
/^-- APM104_LEGACY_DDL (TABLE|TYPE|FUNCTION) [A-Za-z0-9_]+$/ {
  if (waiting) fail("second marker before bound statement")
  split($0, marker, " ")
  kind=marker[3]; object=marker[4]
  key=kind SUBSEP object
  if (seen[key]++) fail("duplicate legacy marker")
  waiting=1; next
}
waiting {
  if ($0 == "" || $0 ~ /^--/) fail("marker must bind the immediately following statement header")
  line=$0; gsub(/public[.]/, "", line); gsub(/"/, "", line); gsub(/[[:space:]]+/, " ", line)
  split(line, token, /[ (]/)
  if (kind == "TABLE" && !(token[1] == "ALTER" && token[2] == "TABLE" && token[3] == object)) fail("TABLE marker mismatch")
  if (kind == "TYPE" && !(token[1] == "ALTER" && token[2] == "TYPE" && token[3] == object)) fail("TYPE marker mismatch")
  if (kind == "FUNCTION" && !(token[1] == "CREATE" && token[2] == "OR" && token[3] == "REPLACE" && token[4] == "FUNCTION" && token[5] == object)) fail("FUNCTION marker mismatch")
  print kind " " object; waiting=0; next
}
END { if (waiting) fail("unbound marker at EOF") }

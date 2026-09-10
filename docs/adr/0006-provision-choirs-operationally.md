# Provision choirs operationally

> 创建、额度与彻底删除规则由 ADR-0017 替代；下文保留原决策背景。
Same Page will retain a multi-drive data and authorization model but will not expose drive creation or closure to product users in V1. Deployment provisions `小红花云盘` and its explicitly configured unique owner, while future drives are created through an operator-only command; this limits public resource abuse without adding billing or a platform administration UI. Each drive has an independently enforced configured file quota, but shares the same D1 and R2 infrastructure with strict ownership and authorization boundaries.

Guest admission and the public preview entry are deployment configuration only; drive permissions cannot change them.

# Provision choirs operationally

Same Page will retain a multi-choir data and authorization model but will not expose choir creation or closure to product users in V1. Deployment provisions `小红花合唱团` and its initial administrator, while future choirs are created through an operator-only command; this limits public resource abuse without adding billing or a platform administration UI. Each choir has an independently enforced one-GB file quota, but shares the same D1 and R2 infrastructure with strict ownership and authorization boundaries.

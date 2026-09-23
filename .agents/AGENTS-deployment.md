# Deployment Conventions

- Apps that need a web server or service must run locally in a random port between 3000 and 3100.

## Versioning

Packages should have their version updated with each PR or deployment, with the target format {year2digits}.{weekOfYear}{weekDay}.{hour}{minute}. This can be accomplished by using the command `shell date '+%y.%-V%u.1%H%M'`. Git tags must NOT be generated with each new version.

For example to update a Node package:

```
npm version $(shell date '+%y.%-V%u.1%H%M') --force --allow-same-version --no-git-tag-version
```

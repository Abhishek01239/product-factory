# Ubuntu 26 Runner Check — launch drafts (v1.0.0, 2026-10-10)

Status: DRAFTED, NOT PUBLISHED (X, Bluesky, Facebook Pages, Mastodon are not connected).
Image: `og.png` (1200×630) — shows real findings from the app's sample workflow.
URL: https://abhishek01239.github.io/product-factory/runner-26-check/

Facts used (actions/runner-images #14748, #13518, #14254 and the 24.04/26.04 image READMEs + toolsets, checked 10 Oct 2026): ubuntu-latest → 26.04 from Oct 19 to Nov 19, 2026; removed: Java 8, Clang 16–18, GCC 12, Miniconda, Swift, Julia, Fastlane, Pulumi, Mercurial, global tsc/webpack/lerna/grunt/gulp/parcel/newman; CMake 3.31→4.4, Compose 2.38→5.1, MySQL 8.0→8.4, Python 3.12→3.14, Node 22→24; macOS 14 unsupported Nov 2, 2026.
Angle: useful first (the list of what's removed, which the announcement doesn't include), tool second.

## X (thread, 3 posts)
1/ ubuntu-latest becomes Ubuntu 26.04 on GitHub Actions from Oct 19.

The announcement lists version bumps. It doesn't list what was removed from the image. From the official toolsets, these are gone:
Java 8 · Clang 16-18 · GCC 12 · Miniconda ($CONDA is empty) · Swift · Julia · Fastlane · Pulumi · global tsc, webpack, lerna, gulp, grunt

2/ Also changing: CMake 3.31 → 4.4 (cmake_minimum_required < 3.5 now errors), Compose 2 → 5, MySQL 8.0 → 8.4 (mysql_native_password off by default), Python 3.12 → 3.14, Node 22 → 24.

3/ I made a free checker: paste a workflow or a public repo and it points at the exact lines that call removed tools, with a fix for each. It also writes a canary workflow that runs 24.04 and 26.04 side by side. Runs in your browser, no token:
https://abhishek01239.github.io/product-factory/runner-26-check/

## Bluesky
GitHub Actions: ubuntu-latest moves to Ubuntu 26.04 between Oct 19 and Nov 19.

Gone from the image: Java 8, Clang 16-18, GCC 12, Miniconda, Swift, Julia, Fastlane, Pulumi and the global tsc/webpack/lerna commands. CMake jumps to 4, Compose to 5.

Free browser tool that finds the affected lines in your workflows:
https://abhishek01239.github.io/product-factory/runner-26-check/

## Mastodon (#GitHubActions #DevOps #CI #Ubuntu)
Heads-up for anyone with CI on GitHub Actions: ubuntu-latest switches to Ubuntu 26.04 from Oct 19, 2026, rolled out repo by repo until Nov 19.

What the announcement doesn't list is what got removed from the image: Java 8, Clang 16–18, GCC 12, Miniconda, Swift, Julia, Fastlane, Pulumi, Mercurial, and the globally installed tsc, webpack, lerna, grunt, gulp, parcel and newman.

I put together a static checker that reads your workflow YAML (or a public repo) and lists the steps that will hit "command not found", with line numbers and a fix each. Nothing is uploaded.
https://abhishek01239.github.io/product-factory/runner-26-check/

## Reddit (r/github, r/devops) — text post, only if community rules allow tool links
Title: ubuntu-latest → 26.04 starts Oct 19: here's what was removed from the image

Body: The runner-images announcement (#14748) covers version bumps but not removals, and someone in the thread asked which preinstalled programs are most likely to break. Diffing the 24.04 and 26.04 toolsets: [list]. Also CMake 4 drops compat with cmake_minimum_required < 3.5, and MySQL 8.4 disables mysql_native_password by default.
Quick fixes: setup-java for Java 8, install-llvm-action for older Clang, setup-miniconda for $CONDA, npx for tsc/webpack/lerna, or pin ubuntu-24.04 to buy time.
I made a free browser checker that does this per line: <URL>. Feedback on false positives welcome.

## Facebook Page
If your team runs CI on GitHub Actions: from Oct 19, ubuntu-latest jobs start running on Ubuntu 26.04. Several tools that used to be preinstalled are gone (Java 8, older Clang and GCC, Miniconda, Swift, Fastlane and others). This free checker reads your workflow files and shows which steps are affected and how to fix them: https://abhishek01239.github.io/product-factory/runner-26-check/

#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source_dir="${script_dir}/sources"
docs_dir="${source_dir}/api-docs"
github_dir="${source_dir}/github"

mkdir -p "${docs_dir}/en" "${docs_dir}/zh-cn" "${github_dir}"

download() {
  local url="$1"
  local output="$2"
  mkdir -p "$(dirname -- "${output}")"
  curl --fail --location --silent --show-error \
    --retry 3 --retry-all-errors \
    --user-agent "web-agent-deepseek-research/1.0" \
    "${url}" \
    --output "${output}"
}

mirror_sitemap() {
  local sitemap_url="$1"
  local sitemap_file="$2"
  local urls_file="$3"
  local output_dir="$4"
  local url
  local relative
  local output

  download "${sitemap_url}" "${sitemap_file}"
  grep -o '<loc>[^<]*' "${sitemap_file}" | sed 's#<loc>##' > "${urls_file}"

  while IFS= read -r url; do
    relative="${url#https://api-docs.deepseek.com/}"
    relative="${relative%/}"
    if [[ "${relative}" == "zh-cn" ]]; then
      relative="index"
    else
      relative="${relative#zh-cn/}"
    fi
    if [[ -z "${relative}" ]]; then
      relative="index"
    fi
    output="${output_dir}/${relative}.html"
    download "${url}" "${output}"
  done < "${urls_file}"
}

mirror_sitemap \
  "https://api-docs.deepseek.com/sitemap.xml" \
  "${docs_dir}/sitemap-en.xml" \
  "${docs_dir}/urls-en.txt" \
  "${docs_dir}/en"

mirror_sitemap \
  "https://api-docs.deepseek.com/zh-cn/sitemap.xml" \
  "${docs_dir}/sitemap-zh-cn.xml" \
  "${docs_dir}/urls-zh-cn.txt" \
  "${docs_dir}/zh-cn"

repositories_json="${github_dir}/deepseek-ai-repositories.json"
download \
  "https://api.github.com/orgs/deepseek-ai/repos?type=public&sort=updated&per_page=100" \
  "${repositories_json}"

jq -r '
  ["name", "description", "language", "stars", "forks", "updated_at", "html_url"],
  (.[] | [
    .name,
    (.description // ""),
    (.language // ""),
    .stargazers_count,
    .forks_count,
    .updated_at,
    .html_url
  ])
  | @tsv
' "${repositories_json}" > "${github_dir}/deepseek-ai-repositories.tsv"

agent_repo="${github_dir}/awesome-deepseek-agent"
if [[ -d "${agent_repo}/.git" ]]; then
  git -C "${agent_repo}" pull --ff-only
else
  git clone --depth 1 \
    https://github.com/deepseek-ai/awesome-deepseek-agent.git \
    "${agent_repo}"
fi

integration_dir="${github_dir}/awesome-deepseek-integration"
mkdir -p "${integration_dir}"
download \
  "https://raw.githubusercontent.com/deepseek-ai/awesome-deepseek-integration/main/README.md" \
  "${integration_dir}/README.md"

english_pages="$(wc -l < "${docs_dir}/urls-en.txt" | tr -d ' ')"
chinese_pages="$(wc -l < "${docs_dir}/urls-zh-cn.txt" | tr -d ' ')"
github_repositories="$(jq 'length' "${repositories_json}")"

printf 'DeepSeek sync complete: %s English docs, %s Chinese docs, %s GitHub repositories.\n' \
  "${english_pages}" \
  "${chinese_pages}" \
  "${github_repositories}"

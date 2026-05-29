> [!CAUTION]
> Please make a backup before using.

image-organizer exists because eventually things get messy in Obsidian.

It should handle

- Missing files
- Mislocated files


## Instalation

Extract the .zip from the Github Action and move it into

[Obsidian Vault]/.obsidian/plugins

It should be look like:

  📁 plugins         📁 image-organizer        📃  main.js
                                                📃 manifest.json
                                                📃 styles.css
  
<img width="668" height="139" alt="image" src="https://github.com/user-attachments/assets/6335b412-5dcf-42ba-8434-72bac7edf4e6" />
                              



## Filtering

After a dry run a log will be printed in 

[Obsidian Vault]/logs/image-organizer-log-YYYYMMDDHHMMSS

This can be filter with simple commands to dive into.

``grep "\[SKIP\]" logs/image-organizer-log-*.md``

> [!CAUTION]
> Please make a backup before using.
> This software comes with no warranty or guarantee.
>
> ChatGPT made it.


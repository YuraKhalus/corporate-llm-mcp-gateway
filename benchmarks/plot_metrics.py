import json
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns
import os

LOG_FILE = "../ai-gateway/logs/gateway_requests.log"
OUTPUT_DIR = "plots"

def parse_logs():
    if not os.path.exists(LOG_FILE):
        print(f"Error: Log file {LOG_FILE} not found.")
        return None

    data = []
    with open(LOG_FILE, 'r') as f:
        content = f.read().strip()
    
    if not content:
        return pd.DataFrame(data)
        
    decoder = json.JSONDecoder()
    idx = 0
    while idx < len(content):
        # Пропускаємо пробіли, табуляції та переноси рядків
        while idx < len(content) and content[idx].isspace():
            idx += 1
        if idx >= len(content):
            break
        try:
            obj, next_idx = decoder.raw_decode(content[idx:])
            data.append(obj)
            idx += next_idx
        except json.JSONDecodeError as e:
            print(f"Skipping malformed JSON chunk at index {idx}...")
            idx += 1

    return pd.DataFrame(data)

def generate_plots(df):
    if not os.path.exists(OUTPUT_DIR):
        os.makedirs(OUTPUT_DIR)

    sns.set_theme(style="whitegrid")

    # Фільтруємо успішні стрімінгові відповіді
    df_streams = df[df['event_type'] == 'STREAM_COMPLETED'].copy()
    if df_streams.empty:
        print("No STREAM_COMPLETED events found in logs.")
        return

    # Забезпечуємо наявність колонок навіть якщо вони пусті у JSON
    required_cols = ['ttft_ms', 'tpot_ms', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'tool_calls_count']
    for col in required_cols:
        if col not in df_streams.columns:
            df_streams[col] = 0
            
    # Замінюємо NaN на 0 для розрахунків
    df_streams[required_cols] = df_streams[required_cols].fillna(0)

    # Додаємо розрахункову колонку Tokens Per Second (TPS)
    # TPS = 1000 ms / TPOT_ms
    df_streams['tps'] = df_streams['tpot_ms'].apply(lambda x: 1000 / x if pd.notnull(x) and x > 0 else 0)

    # 1. Boxplot: TTFT (Time to First Token) by Model
    plt.figure(figsize=(10, 6))
    ax = sns.boxplot(data=df_streams, x='model', y='ttft_ms', hue='model', legend=False, palette='Set2', showfliers=False)
    # Накладаємо окремі точки
    sns.stripplot(data=df_streams, x='model', y='ttft_ms', hue='model', legend=False, color='black', alpha=0.6, jitter=True, size=6)
    plt.yscale('log')
    from matplotlib.ticker import ScalarFormatter
    ax.yaxis.set_major_formatter(ScalarFormatter())
    plt.title('Time To First Token (TTFT) by Model (Log Scale)', fontsize=14)
    plt.xlabel('Модель', fontsize=12)
    plt.ylabel('TTFT (мс)', fontsize=12)
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/ttft_comparison.png", dpi=300)
    plt.close()

    # 2. Boxplot: TPS (Tokens Per Second) by Model
    plt.figure(figsize=(10, 6))
    sns.boxplot(data=df_streams[df_streams['tps'] > 0], x='model', y='tps', hue='model', legend=False, palette='Set1', showfliers=False)
    sns.stripplot(data=df_streams[df_streams['tps'] > 0], x='model', y='tps', hue='model', legend=False, color='black', alpha=0.6, jitter=True, size=6)
    plt.title('Швидкість генерації (Tokens Per Second) by Model', fontsize=14)
    plt.xlabel('Модель', fontsize=12)
    plt.ylabel('Tokens / sec', fontsize=12)
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/tps_comparison.png", dpi=300)
    plt.close()

    # 3. Barplot: Total Duration vs TTFT by Model
    # Усереднюємо значення
    df_mean = df_streams.groupby('model')[['duration_ms', 'ttft_ms']].mean().reset_index()
    
    plt.figure(figsize=(10, 6))
    sns.barplot(data=df_mean, x='model', y='duration_ms', color='lightblue', label='Total Duration')
    sns.barplot(data=df_mean, x='model', y='ttft_ms', color='darkblue', label='TTFT (Thinking Time)')
    plt.title('Середній загальний час vs Час на роздуми (TTFT)', fontsize=14)
    plt.xlabel('Модель', fontsize=12)
    plt.ylabel('Час (мс)', fontsize=12)
    plt.legend()
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/duration_vs_ttft.png", dpi=300)
    plt.close()

    # 4. Scatterplot: Prompt Tokens vs TTFT (Чи залежить TTFT від розміру контексту?)
    plt.figure(figsize=(10, 6))
    sns.scatterplot(data=df_streams, x='prompt_tokens', y='ttft_ms', hue='model', size='tool_calls_count', sizes=(50, 200), alpha=0.7)
    plt.title('Вплив розміру контексту (Prompt Tokens) на TTFT', fontsize=14)
    plt.xlabel('Prompt Tokens', fontsize=12)
    plt.ylabel('TTFT (мс)', fontsize=12)
    plt.legend(bbox_to_anchor=(1.05, 1), loc='upper left')
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/context_vs_ttft.png", dpi=300)
    plt.close()

    # 5. Співвідношення подій (Security Blocks vs Success)
    plt.figure(figsize=(8, 6))
    event_counts = df['event_type'].value_counts()
    sns.barplot(x=event_counts.index, y=event_counts.values, hue=event_counts.index, palette='viridis', legend=False)
    plt.title('Кількість подій за типами (Успіх / Блокування)', fontsize=14)
    plt.xlabel('Тип події', fontsize=12)
    plt.ylabel('Кількість', fontsize=12)
    plt.tight_layout()
    plt.savefig(f"{OUTPUT_DIR}/event_counts.png", dpi=300)
    plt.close()

    print(f"Усі метрики для диплому згенеровано у папці '{OUTPUT_DIR}'!")
    
    print("\n Базова статистика:")
    for model in df_streams['model'].unique():
        m_df = df_streams[df_streams['model'] == model]
        print(f"\nМодель: {model}")
        print(f"  Всього успішних запитів: {len(m_df)}")
        print(f"  Середній TTFT: {m_df['ttft_ms'].mean():.2f} мс")
        print(f"  Середня швидкість: {m_df['tps'].mean():.2f} токенів/сек")
        print(f"  Макс. час генерації (E2E): {m_df['duration_ms'].max()} мс")
        tool_invocations = m_df['tool_calls_count'].sum()
        print(f"  Всього викликано MCP тулів: {tool_invocations}")

if __name__ == "__main__":
    print("Аналіз нових логів AI Gateway...")
    df = parse_logs()
    if df is not None and not df.empty:
        generate_plots(df)
    else:
        print("Logs are empty or unreadable.")

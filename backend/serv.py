from flask import Flask, request, render_template, jsonify
from flask_cors import CORS
import pandas as pd
import time
import json
import os

app = Flask(__name__)
CORS(app)
last_write = time.time()

WRITE_AFTER_TIME = 10

like_table = pd.DataFrame({})
distinguished_fingerprints = pd.DataFrame({})

def init_tables():
    global like_table, distinguished_fingerprints
    if os.path.exists('./cache/likeTable.csv'):
        like_table = pd.read_csv('./cache/likeTable.csv')
    else:
        like_table = pd.DataFrame(columns=['project_id', 'likes'])

    if os.path.exists('./cache/distinguishedFingerprints.csv'):
        distinguished_fingerprints = pd.read_csv('./cache/distinguishedFingerprints.csv')
    else:    
        distinguished_fingerprints = pd.DataFrame(columns=['fingerprint', 'project_ids'])

def write_like_table():
    global like_table, distinguished_fingerprints
    distinguished_fingerprints.to_csv('./cache/distinguishedFingerprints.csv', index=False)
    like_table.to_csv('./cache/likeTable.csv', index=False)

@app.route('/getGlobLikeStruct', methods=['GET'])
def get_glob_like_struct():
    global like_table
    return like_table.to_json(orient='records')

@app.route('/postNewLike', methods=['GET'])
def post_new_like():
    global like_table, distinguished_fingerprints, last_write
    project_id = int(request.args.get('project_id'))

    fingerprint = request.args.get('fingerprint') + '-' + str(request.remote_addr)

    if fingerprint in distinguished_fingerprints['fingerprint'].values:
        project_ids = distinguished_fingerprints.loc[distinguished_fingerprints['fingerprint'] == fingerprint, 'project_ids'].values[0]
        project_ids = json.loads(project_ids)
        project_ids.append(int(project_id))
        print(project_ids)

        distinguished_fingerprints.loc[distinguished_fingerprints['fingerprint'] == fingerprint, 'project_ids'] = json.dumps(project_ids)
    else:
        distinguished_fingerprints = distinguished_fingerprints.append({'fingerprint': fingerprint, 'project_ids': json.dumps([int(project_id)])}, ignore_index=True)
    
    if int(project_id) in like_table['project_id'].values:
        like_table.loc[like_table['project_id'] == project_id, 'likes'] += 1
    else:
        like_table = like_table.append({'project_id': int(project_id), 'likes': 1}, ignore_index=True)

    if time.time() - last_write > WRITE_AFTER_TIME:
        write_like_table()
        last_write = time.time()

    return jsonify({'status': 'success'})

@app.route('/initPageLoad', methods=['GET'])
def init_page_load():
    global distinguished_fingerprints
    fingerprint = request.args.get('fingerprint') + str(request.remote_addr)
    if fingerprint in distinguished_fingerprints['fingerprint'].values:
        project_ids = distinguished_fingerprints.loc[distinguished_fingerprints['fingerprint'] == fingerprint, 'project_ids'].values[0]
        project_ids = json.loads(project_ids)
        return json.dumps(project_ids)
    else:
        return json.dumps([])

if __name__ == '__main__':
    init_tables()
    app.run(host='0.0.0.0', port=8080)
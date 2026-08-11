FROM python:3.12-slim

WORKDIR /workspace
COPY scripts/trajectory_review/requirements.txt /tmp/trajectory-requirements.txt
RUN pip install --no-cache-dir -r /tmp/trajectory-requirements.txt awscli

COPY scripts/trajectory_review /workspace/scripts/trajectory_review

ENTRYPOINT ["python", "scripts/trajectory_review/run.py"]
